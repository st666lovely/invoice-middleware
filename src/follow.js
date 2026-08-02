"use strict";

/**
 * follow.js — Theo dõi hóa đơn chủ động qua Telegram (v3 — gộp với hối thúc)
 *
 * Thiết kế:
 * - Web chỉ còn 1 nút "Hối thúc & Theo dõi". Khi khách bấm:
 *     1. POST /api/follow-invoice  -> nhận token + link t.me (nhanh, đồng bộ)
 *     2. POST /api/urgent-invoice  -> gửi tin hối thúc ĐẦY ĐỦ (ảnh hóa đơn,
 *        họ tên, mã CK, mã nội bộ từ BO) vào nhóm CS, kèm followToken
 *     3. Web mở Telegram -> khách bấm Start
 * - Nhóm CS chỉ nhận 1 tin duy nhất (tin hối thúc đầy đủ), không còn tin
 *   rỗng toàn dấu "-" như bản v2.
 * - Vì /api/urgent-invoice chạy nền (BO lookup + có thể cả Playwright) nên
 *   message_id chỉ có sau vài giây, trong khi khách có thể bấm Start trước.
 *   Cơ chế "chờ khớp" hai chiều xử lý cả 2 thứ tự:
 *     · Start trước  -> giữ chatId trong token, hối thúc xong thì gắn vào
 *     · Hối thúc trước -> giữ root trong token, Start đến thì gắn ngay
 *   Nếu quá FOLLOW_MATCH_FALLBACK_MS mà hối thúc không gửi được tin nào
 *   (BO không trả mã nội bộ, lỗi mạng...) thì tự tạo tin dự phòng vào nhóm
 *   CS để khách không bị bỏ rơi.
 * - chatId của khách được gắn vào entry trong cache của telegram.js
 *   (trường followChatId trên imageCache — cùng tư duy với t3Links).
 * - CS xử lý y như luồng hối thúc hiện tại (bấm nút ✅/❌, hoặc chuyển T3).
 * - Ngay tại 2 điểm telegram.js chốt trạng thái cuối (handleCskhCallback
 *   nhánh "cskh:done", và processT3Reply) — telegram.js tự bắn thẳng kết
 *   quả về DM khách qua sendStatusToCustomer() ở dưới, không cần follow.js
 *   chủ động hỏi lại.
 * - Khách nhắn lại bất cứ lúc nào → tra thẳng trạng thái CS đã chốt gần nhất
 *   (getInvoiceStatusByMsgId của telegram.js) — không còn hỏi BO.
 *
 * Đã BỎ HOÀN TOÀN: poll 30s, TTL theo dõi đẩy, lookupDeposit/
 * invalidateDepositCache — không cần job nền, không cần đoán/khớp dữ liệu,
 * vì liên kết đã có sẵn ngay từ lúc tạo.
 *
 * Dùng bot Telegram RIÊNG (FOLLOW_TG_BOT_TOKEN) cho phần DM khách — không
 * dùng chung bot CS, để tránh cướp webhook và làm hỏng bot đang chạy. Tin
 * gửi vào nhóm CS thì dùng chung URGENT_TG_BOT_TOKEN/URGENT_TG_GROUP_ID như
 * luồng hối thúc, theo đúng yêu cầu không tạo thêm biến môi trường mới.
 */

const axios  = require("axios");
const fs     = require("fs");
const crypto = require("crypto");
const logger = require("./logger");
// Require ở đầu file là AN TOÀN theo chiều này: telegram.js không require
// follow.js ở đầu file của nó (chỉ require trễ bên trong hàm
// notifyFollowCustomer lúc gọi), nên không có circular require lúc load.
const { addManualInvoice, getInvoiceStatusByMsgId, telegramService } = require("./telegram");

// ── Cấu hình ──────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.FOLLOW_TG_BOT_TOKEN || process.env.URGENT_TG_BOT_TOKEN || null;
const USING_FALLBACK_TOKEN = !process.env.FOLLOW_TG_BOT_TOKEN && !!process.env.URGENT_TG_BOT_TOKEN;

const DB_PATH    = process.env.FOLLOW_DB_PATH   || "./follow-db.json";
// Số lượng tối đa "khách đã từng liên kết" được nhớ vĩnh viễn để tra cứu
// chủ động (knownUsers) — bảng này KHÔNG hết hạn theo thời gian, chỉ giới
// hạn theo dung lượng (LRU đơn giản: xoá bản ghi cũ nhất khi đầy).
const MAX_KNOWN  = parseInt(process.env.FOLLOW_MAX_KNOWN) || 5000;
const TOKEN_TTL_MS = 30 * 60_000; // link Start hết hạn sau 30 phút nếu chưa bấm
// Link CSKH gắn vào nút dưới mỗi tin nhắn. Có mặc định để nút luôn hiện kể cả
// khi chưa khai biến môi trường — AE888 thì set FOLLOW_CSKH_URL để đè lên.
const CSKH_URL     = process.env.FOLLOW_CSKH_URL || "https://t.me/st666cskh247";
// Cooldown tra cứu chủ động — tránh khách bấm gửi dồn dập làm spam tin nhắn.
const CHECK_COOLDOWN_MS = 10_000;
// Khách đã bấm Start nhưng hối thúc chưa gửi được tin vào nhóm CS sau ngần
// này thì tự tạo tin dự phòng, tránh khách chờ mãi không ai xử lý.
const MATCH_FALLBACK_MS = parseInt(process.env.FOLLOW_MATCH_FALLBACK_MS) || 90_000;

let BOT_USERNAME = process.env.FOLLOW_TG_BOT_USERNAME || null;
const api = () => `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── State (in-memory + persist file) ────────────────────────────────────────
// token(12 ký tự) -> {
//   username, transferContent, createdAt, expiresAt,
//   chatId  : có khi khách đã bấm Start
//   root    : có khi hối thúc đã gửi xong tin vào nhóm CS
//   timer   : hẹn giờ tạo tin dự phòng nếu chờ root quá lâu
// }
// Token chỉ bị xoá khi đã khớp đủ cả 2 vế, hoặc hết hạn mà chưa ai dùng.
const pendingTokens = new Map();
// chatId -> { username, transferContent, rootId, updatedAt, lastStatus, lastNote }
// Bảng nhớ vĩnh viễn để khách tra cứu chủ động bất cứ lúc nào; rootId trỏ
// thẳng tới message gốc trong cache của telegram.js (nơi CS xác nhận).
const knownUsers    = new Map();
const lastCheckAt   = new Map(); // chatId -> timestamp (cooldown tra cứu chủ động)

let _saveTimer  = null;

// ── Persistence ───────────────────────────────────────────────────────────────
function loadDb() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const raw  = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    for (const k of data.known || []) knownUsers.set(k.chatId, k);
    logger.info("Follow DB loaded", { known: knownUsers.size });
  } catch (e) {
    logger.error("Follow DB load failed", { error: e.message });
  }
}

function saveDbNow() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify({
      known: Array.from(knownUsers.entries()).map(([chatId, v]) => ({ chatId, ...v })),
    }, null, 2));
  } catch (e) {
    logger.error("Follow DB save failed", { error: e.message });
  }
}

function saveDbDebounced() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveDbNow, 2_000);
}

// ── Ghi nhớ liên kết chatId <-> username/rootId (vĩnh viễn, để tra cứu) ───────
function rememberUser(chatId, username, transferContent, rootId) {
  if (knownUsers.size >= MAX_KNOWN && !knownUsers.has(chatId)) {
    // LRU đơn giản: xoá bản ghi cũ nhất (Map giữ thứ tự insert)
    knownUsers.delete(knownUsers.keys().next().value);
  }
  const prev = knownUsers.get(chatId) || {};
  knownUsers.set(chatId, {
    username:        (username || prev.username || "").trim(),
    transferContent: (transferContent || prev.transferContent || "").trim(),
    rootId:          rootId != null ? Number(rootId) : (prev.rootId || null),
    updatedAt:       Date.now(),
    lastStatus:      prev.lastStatus || null,
    lastNote:        prev.lastNote   || null,
  });
}

// ── Token 12 ký tự A-Za-z0-9 (hợp lệ với ?start=) ──────────────────────────────
function genToken() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(12);
  let t = "";
  for (let i = 0; i < 12; i++) t += chars[bytes[i] % chars.length];
  return t;
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cskhKeyboard() {
  if (!CSKH_URL) return undefined;
  return { inline_keyboard: [[{ text: "💬 Liên hệ CSKH", url: CSKH_URL }]] };
}

async function tgSend(chatId, text, extra = {}) {
  try {
    await axios.post(`${api()}/sendMessage`, {
      chat_id: chatId, text, parse_mode: "HTML", ...extra,
    }, { timeout: 15_000 });
  } catch (e) {
    logger.error("Follow tgSend failed", { chatId, error: e.response?.data || e.message });
  }
}

// ── Public: tạo link "Theo dõi qua Telegram" cho frontend ─────────────────────
// Gọi trong route POST /api/follow-invoice của server.js.
// LƯU Ý CHO FRONTEND: mở window.open("about:blank") ngay trong sự kiện click,
// rồi mới gán .location = link sau khi có response — tránh popup blocker.
function createFollowLink(username, transferContent) {
  if (!BOT_TOKEN)    throw new Error("FOLLOW_TG_BOT_TOKEN chưa được cấu hình");
  if (!BOT_USERNAME) throw new Error("Bot chưa sẵn sàng (đang lấy username), thử lại sau vài giây");

  const now = Date.now();
  for (const [tok, v] of pendingTokens) {
    // Chỉ dọn token chưa ai dùng. Token đã có chatId hoặc root nghĩa là đang
    // chờ khớp nốt vế còn lại — xoá lúc này sẽ làm đứt liên kết của khách.
    if (now > v.expiresAt && !v.chatId && !v.root) pendingTokens.delete(tok);
  }

  const token = genToken();
  pendingTokens.set(token, {
    username:        (username || "").trim(),
    transferContent: (transferContent || "").trim(),
    createdAt:  now,
    expiresAt:  now + TOKEN_TTL_MS,
  });

  return {
    token,
    link: `https://t.me/${BOT_USERNAME}?start=${token}`,
    expiresInMinutes: TOKEN_TTL_MS / 60_000,
  };
}

// ── Khớp token với tin hối thúc (2 chiều) ────────────────────────────────────

// Server.js gọi TRƯỚC khi addManualInvoice để biết có gắn followChatId luôn
// được không (trường hợp khách đã bấm Start xong từ trước).
function getChatIdForToken(token) {
  if (!token) return null;
  const p = pendingTokens.get(token);
  return p && p.chatId ? p.chatId : null;
}

// Cả 2 vế đã đủ — gắn chatId khách vào đúng entry của tin hối thúc.
function linkRootToChat(token, pending) {
  clearTimeout(pending.timer);
  pending.timer = null;

  const r = pending.root;
  // Gọi lại addManualInvoice với cùng message_id: ghi đè entry trong
  // imageCache kèm followChatId. replyIndex nằm riêng nên các reply CS đã có
  // không bị mất.
  const entry = addManualInvoice({
    messageId:    r.messageId,
    username:     r.username     || pending.username,
    fullname:     r.fullname     || null,
    ckCode:       r.ckCode       || pending.transferContent,
    orderCode:    r.orderCode    || "-",
    status:       r.status       || "-",
    note:         r.note         || null,
    fileId:       r.fileId       || null,
    followChatId: pending.chatId,
  });

  rememberUser(
    pending.chatId,
    r.username || pending.username,
    r.ckCode   || pending.transferContent,
    entry.message_id
  );
  saveDbDebounced();
  pendingTokens.delete(token);

  logger.info("Follow linked to urgent message", {
    token, chatId: pending.chatId, rootId: entry.message_id, username: entry.username,
  });
  return entry;
}

// Server.js gọi SAU khi gửi tin hối thúc thành công.
function attachUrgentRoot(token, root) {
  if (!token || !root || !root.messageId) return false;
  const pending = pendingTokens.get(token);
  if (!pending) {
    logger.warn("Follow attachUrgentRoot: token không tồn tại", { token });
    return false;
  }
  pending.root = root;
  if (pending.chatId) linkRootToChat(token, pending);
  return true;
}

// Server.js gọi khi hối thúc phát hiện đơn ĐÃ lên điểm nên không gửi nhóm CS.
// Báo thẳng khách rồi huỷ token, không để hẹn giờ dự phòng bắn tin thừa.
function resolveAlreadyCredited(token, depositAmt, depositTime) {
  if (!token) return false;
  const pending = pendingTokens.get(token);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingTokens.delete(token);

  if (!pending.chatId) return false; // khách chưa bấm Start thì thôi

  let extra = "";
  try {
    const amt  = Number(depositAmt);
    const time = depositTime
      ? new Date(depositTime).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
      : null;
    if (Number.isFinite(amt) && amt > 0) extra += `\n\n💰 Số tiền: <b>${amt.toLocaleString("vi-VN")}</b>`;
    if (time) extra += `\n🕐 Thời gian: ${escapeHtml(time)}`;
  } catch (e) { /* bỏ qua, chỉ là phần hiển thị thêm */ }

  tgSend(pending.chatId,
    `✅ <b>Đơn nạp của bạn đã được ghi nhận!</b>${extra}\n\nVui lòng kiểm tra lại số dư tài khoản.`,
    { reply_markup: cskhKeyboard() }
  );
  logger.info("Follow resolved as already credited", { token, chatId: pending.chatId });
  return true;
}

// Hẹn giờ dự phòng: khách đã Start nhưng hối thúc không gửi được tin nào vào
// nhóm CS (BO không trả mã nội bộ, lỗi mạng, bị chặn trùng...).
async function fallbackRegister(token) {
  const pending = pendingTokens.get(token);
  if (!pending || !pending.chatId || pending.root) return;

  logger.warn("Follow fallback: hối thúc không gửi được tin, tạo tin dự phòng", {
    token, username: pending.username,
  });

  const entry = await registerFollowInvoice(pending.chatId, pending.username, pending.transferContent);
  if (!entry) {
    return tgSend(pending.chatId,
      "⚠️ Có trục trặc khi chuyển đơn của bạn tới CSKH. Vui lòng liên hệ CSKH để được hỗ trợ trực tiếp.",
      { reply_markup: cskhKeyboard() }
    );
  }

  rememberUser(pending.chatId, pending.username, pending.transferContent, entry.message_id);
  saveDbDebounced();
  pendingTokens.delete(token);
}

// ── Gắn liên kết ngay tại thời điểm tạo: gửi tin vào nhóm CS + lưu chatId ─────
// Giống hệt tư duy t3Links: liên kết được lưu NGAY khi tin được tạo ra, không
// cần job nền đi khớp lại sau. Trả về entry (có message_id) hoặc null nếu lỗi.
async function registerFollowInvoice(chatId, username, transferContent) {
  const token       = process.env.URGENT_TG_BOT_TOKEN;
  const csGroupId   = process.env.URGENT_TG_GROUP_ID;

  if (!token || !csGroupId) {
    logger.error("Follow: thiếu cấu hình URGENT_TG_BOT_TOKEN/URGENT_TG_GROUP_ID");
    return null;
  }

  const caption = [
    username || "-",
    "-", // họ tên — không có vì tin hối thúc đầy đủ đã thất bại
    transferContent || "-",
    "-", // mã nội bộ — BO không trả về
    "Khách theo dõi qua Telegram (chưa lấy được mã nội bộ)",
    "-",
  ].join("\n");

  let sent;
  try {
    const r = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: csGroupId,
      text: caption,
      reply_markup: telegramService.buildCskhKeyboard(),
    }, { timeout: 15_000 });
    sent = r.data?.result;
  } catch (e) {
    logger.error("Follow: gửi tin nhóm CS thất bại", { error: e.response?.data || e.message, username });
    return null;
  }

  const entry = addManualInvoice({
    messageId:    sent?.message_id,
    username,
    fullname:     null,
    ckCode:       transferContent,
    orderCode:    "-",
    status:       "-",
    note:         "Khách theo dõi qua Telegram (chưa lấy được mã nội bộ)",
    followChatId: chatId,
  });

  logger.info("Follow invoice registered", { chatId, username, rootId: entry.message_id });
  return entry;
}

// ── Bắn kết quả trạng thái thẳng về DM khách (gọi bởi telegram.js) ───────────
// Đây là điểm mà handleCskhCallback ("cskh:done") và processT3Reply gọi vào
// ngay khi CS chốt trạng thái — không cần khách hỏi lại.
async function sendStatusToCustomer(chatId, status, note) {
  if (!chatId) return;

  const known = knownUsers.get(chatId);
  if (known) {
    known.lastStatus = status || known.lastStatus;
    known.lastNote   = note   || known.lastNote;
    known.updatedAt  = Date.now();
    saveDbDebounced();
  }

  const lines = [];
  if (status === "Đã lên điểm") {
    lines.push("✅ <b>Hóa đơn của bạn đã được ghi nhận!</b>");
  } else {
    lines.push(`ℹ️ Cập nhật trạng thái đơn: <b>${escapeHtml(status || "-")}</b>`);
  }
  if (note) lines.push(escapeHtml(note));

  return tgSend(chatId, lines.join("\n\n"), { reply_markup: cskhKeyboard() });
}

// ── Tra cứu chủ động theo yêu cầu (khách gõ bất kỳ tin nhắn nào) ──────────────
async function checkNow(chatId) {
  const known = knownUsers.get(chatId);
  if (!known) {
    return tgSend(chatId,
      "👋 Mình chưa có thông tin đơn nào của bạn. Vui lòng vào trang tra cứu hóa đơn, bấm nút hối thúc & theo dõi để bắt đầu liên kết tài khoản.",
      { reply_markup: cskhKeyboard() }
    );
  }

  // Đã Start nhưng tin hối thúc chưa gửi xong -> chưa có rootId để tra.
  if (!known.rootId) {
    return tgSend(chatId,
      `⏳ Đơn của bạn (tài khoản <b>${escapeHtml(known.username)}</b>) đang được chuyển tới CSKH. Mình sẽ nhắn ngay khi có kết quả.`,
      { reply_markup: cskhKeyboard() }
    );
  }

  const now = Date.now();
  const lastAt = lastCheckAt.get(chatId) || 0;
  if (now - lastAt < CHECK_COOLDOWN_MS) {
    return; // im lặng bỏ qua nếu khách gửi dồn dập, tránh spam
  }
  lastCheckAt.set(chatId, now);

  const result = getInvoiceStatusByMsgId(known.rootId);
  if (!result) {
    return tgSend(chatId,
      `❓ Chưa tìm thấy thông tin đơn cho tài khoản <b>${escapeHtml(known.username)}</b>. Vui lòng liên hệ CSKH để được hỗ trợ.`,
      { reply_markup: cskhKeyboard() }
    );
  }

  known.lastStatus = result.status;
  known.lastNote   = result.note;
  known.updatedAt  = now;
  saveDbDebounced();

  if (result.status === "Đã lên điểm") {
    return tgSend(chatId,
      `✅ Hóa đơn của bạn (tài khoản <b>${escapeHtml(known.username)}</b>) đã được ghi nhận!` +
      (result.note ? `\n\n${escapeHtml(result.note)}` : "") +
      `\n\nCần hỗ trợ thêm, bạn bấm nút bên dưới để gặp CSKH nhé.`,
      { reply_markup: cskhKeyboard() }
    );
  }

  if (!result.status || result.status === "-") {
    return tgSend(chatId,
      `⏳ Đơn của bạn (tài khoản <b>${escapeHtml(known.username)}</b>) đang chờ CSKH xử lý. Mình sẽ nhắn ngay khi có kết quả, hoặc bạn cứ nhắn lại vào đây bất cứ lúc nào để kiểm tra.`,
      { reply_markup: cskhKeyboard() }
    );
  }

  return tgSend(chatId,
    `ℹ️ Trạng thái đơn của bạn (tài khoản <b>${escapeHtml(known.username)}</b>): <b>${escapeHtml(result.status)}</b>` +
    (result.note ? `\n\n${escapeHtml(result.note)}` : ""),
    { reply_markup: cskhKeyboard() }
  );
}

// ── Webhook Telegram (POST /webhook/follow) ────────────────────────────────────
async function handleWebhook(update) {
  const msg = update?.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text   = msg.text.trim();

  if (text.startsWith("/start")) {
    const token = text.split(/\s+/)[1];

    if (!token) {
      // /start trơn (không token) — nếu đã từng liên kết trước đó, coi như
      // một lần tra cứu chủ động; nếu chưa, hướng dẫn ra web.
      if (knownUsers.has(chatId)) return checkNow(chatId);
      return tgSend(chatId,
        "👋 Chào bạn. Vui lòng bấm nút \"Theo dõi qua Telegram\" trên trang tra cứu hóa đơn để bắt đầu.",
        { reply_markup: cskhKeyboard() }
      );
    }

    const pending = pendingTokens.get(token);
    if (!pending) {
      return tgSend(chatId,
        "⚠️ Link theo dõi không hợp lệ hoặc đã hết hạn (30 phút). Vui lòng quay lại trang web và bấm \"Theo dõi qua Telegram\" lại.",
        { reply_markup: cskhKeyboard() }
      );
    }
    // Ghi nhận chatId vào token. KHÔNG gửi tin riêng vào nhóm CS nữa —
    // tin hối thúc đầy đủ (có ảnh + mã nội bộ) mới là tin chính thức.
    pending.chatId = chatId;

    // Nhớ khách ngay (rootId để trống, sẽ điền khi khớp được tin hối thúc)
    // để nếu khách gõ /status trong lúc chờ thì vẫn nhận trả lời đúng.
    rememberUser(chatId, pending.username, pending.transferContent, null);
    saveDbDebounced();

    if (pending.root) {
      // Hối thúc đã gửi xong trước khi khách bấm Start — gắn ngay.
      linkRootToChat(token, pending);
    } else if (!pending.timer) {
      // Khách bấm Start trước — chờ hối thúc gửi xong rồi khớp lại.
      pending.timer = setTimeout(() => {
        fallbackRegister(token).catch(e =>
          logger.error("Follow fallbackRegister error", { error: e.message, token })
        );
      }, MATCH_FALLBACK_MS);
      logger.info("Follow chờ khớp tin hối thúc", { chatId, username: pending.username, token });
    }

    return tgSend(chatId,
      `✅ Đã ghi nhận theo dõi hóa đơn cho tài khoản <b>${escapeHtml(pending.username)}</b>` +
      (pending.transferContent ? ` (mã CK: ${escapeHtml(pending.transferContent)})` : "") +
      `.\n\nBộ phận CSKH sẽ xử lý và mình sẽ nhắn ngay cho bạn khi có kết quả — không cần quay lại web để kiểm tra.\n\n` +
      `Bạn cũng có thể nhắn lại vào đây bất cứ lúc nào để mình kiểm tra trạng thái mới nhất, hoặc gõ /status.`,
      { reply_markup: cskhKeyboard() }
    );
  }

  if (text === "/status" || text === "/check") {
    return checkNow(chatId);
  }

  // Bất kỳ tin nhắn nào khác — coi như khách muốn kiểm tra lại đơn ngay.
  return checkNow(chatId);
}

// ── Admin: xem ai đang được liên kết theo dõi ───────────────────────────────────
function getAll() {
  return Array.from(knownUsers.entries()).map(([chatId, v]) => ({
    chatId,
    username:        v.username,
    transferContent: v.transferContent,
    rootId:          v.rootId,
    lastStatus:      v.lastStatus,
    lastNote:        v.lastNote,
    updatedAt:       new Date(v.updatedAt).toISOString(),
  }));
}

// ── Khởi động (gọi trong app.listen của server.js) ───────────────────────────────
async function start(publicUrl) {
  if (!BOT_TOKEN) {
    logger.warn("FOLLOW_TG_BOT_TOKEN chưa cấu hình — tính năng theo dõi Telegram bị tắt");
    return;
  }
  if (USING_FALLBACK_TOKEN) {
    logger.error(
      "FOLLOW_TG_BOT_TOKEN chưa set — đang fallback dùng chung URGENT_TG_BOT_TOKEN. " +
      "Việc này sẽ CƯỚP webhook của bot CS hiện tại và làm hỏng bot đang chạy. " +
      "Vui lòng tạo bot riêng qua @BotFather rồi set FOLLOW_TG_BOT_TOKEN."
    );
  }

  loadDb();

  if (!BOT_USERNAME) {
    try {
      const r = await axios.get(`${api()}/getMe`, { timeout: 10_000 });
      BOT_USERNAME = r.data?.result?.username || null;
      logger.info("Follow bot username resolved", { username: BOT_USERNAME });
    } catch (e) {
      logger.error("Follow getMe failed", { error: e.response?.data || e.message });
    }
  }

  if (publicUrl) {
    try {
      await axios.post(`${api()}/setWebhook`, {
        url: `${publicUrl.replace(/\/$/, "")}/webhook/follow`,
      }, { timeout: 10_000 });
      logger.info("Follow webhook set", { url: `${publicUrl}/webhook/follow` });
    } catch (e) {
      logger.error("Follow setWebhook failed", { error: e.response?.data || e.message });
    }
  } else {
    logger.warn("PUBLIC_URL chưa set — bỏ qua setWebhook cho follow bot");
  }

  logger.info("Follow module started (chế độ CS xác nhận tay, không còn polling BO)");
}

module.exports = {
  start,
  createFollowLink,
  handleWebhook,
  getAll,
  sendStatusToCustomer,
  // Dùng cho luồng gộp hối thúc + theo dõi (gọi từ server.js)
  getChatIdForToken,
  attachUrgentRoot,
  resolveAlreadyCredited,
};
