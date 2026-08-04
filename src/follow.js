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
// Số dòng lịch sử tin nhắn giữ lại (cả tin bot gửi lẫn tin khách nhắn).
// Quá số này thì tự xoá dòng cũ nhất, tránh file dữ liệu phình vô hạn.
const LOG_MAX    = parseInt(process.env.FOLLOW_LOG_MAX) || 3000;
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
// Giữ tạm danh tính Telegram của khách trước khi rememberUser() được gọi
// (lúc /start, bản ghi knownUsers chưa tồn tại).
const pendingTgProfile = new Map();
// Lịch sử tin nhắn, mới nhất nằm cuối mảng.
// { at, chatId, dir:"out"|"in", text, ok, error, username, tgName }
const msgLog = [];
const lastCheckAt   = new Map(); // chatId -> timestamp (cooldown tra cứu chủ động)

let _saveTimer  = null;

// ── Persistence ───────────────────────────────────────────────────────────────
function loadDb() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const raw  = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    for (const k of data.known || []) knownUsers.set(k.chatId, k);
    if (Array.isArray(data.log)) msgLog.push(...data.log.slice(-LOG_MAX));
    logger.info("Follow DB loaded", { known: knownUsers.size, log: msgLog.length });
  } catch (e) {
    logger.error("Follow DB load failed", { error: e.message });
  }
}

function saveDbNow() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify({
      known: Array.from(knownUsers.entries()).map(([chatId, v]) => ({ chatId, ...v })),
      log:   msgLog,
    }));
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
  const prof = pendingTgProfile.get(chatId) || {};
  knownUsers.set(chatId, {
    tgName:          prof.tgName     || prev.tgName     || null,
    tgUsername:      prof.tgUsername || prev.tgUsername || null,
    sentCount:       prev.sentCount    || 0,
    lastSentAt:      prev.lastSentAt   || null,
    lastSentText:    prev.lastSentText || null,
    lastError:       prev.lastError    || null,
    lastErrorAt:     prev.lastErrorAt  || null,
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

// Ghi 1 dòng vào sổ lịch sử tin nhắn.
function pushLog(chatId, dir, text, errorMsg) {
  const k = knownUsers.get(chatId) || {};
  msgLog.push({
    at:       Date.now(),
    chatId,
    dir,
    text:     String(text || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 400),
    ok:       !errorMsg,
    error:    errorMsg ? String(errorMsg).slice(0, 200) : null,
    username: k.username || null,
    tgName:   k.tgName   || null,
  });
  if (msgLog.length > LOG_MAX) msgLog.splice(0, msgLog.length - LOG_MAX);
  saveDbDebounced();
}

// Ghi nhật ký gửi vào chính bản ghi của khách: đếm số tin, giờ gửi cuối, nội
// dung tin cuối và lỗi gần nhất (khách chặn bot / xoá chat sẽ báo lỗi ở đây).
function logSend(chatId, text, errorMsg) {
  const k = knownUsers.get(chatId);
  if (!k) return; // tin gửi cho người chưa liên kết thì không cần lưu
  if (errorMsg) {
    k.lastError   = String(errorMsg).slice(0, 200);
    k.lastErrorAt = Date.now();
  } else {
    k.sentCount    = (k.sentCount || 0) + 1;
    k.lastSentAt   = Date.now();
    k.lastSentText = String(text || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
    k.lastError    = null;
  }
  saveDbDebounced();
}

async function tgSend(chatId, text, extra = {}) {
  try {
    await axios.post(`${api()}/sendMessage`, {
      chat_id: chatId, text, parse_mode: "HTML", ...extra,
    }, { timeout: 15_000 });
    logSend(chatId, text, null);
    pushLog(chatId, "out", text, null);
    logger.info("Follow tgSend ok", { chatId });
  } catch (e) {
    const err = e.response?.data?.description || e.message;
    logSend(chatId, text, err);
    pushLog(chatId, "out", text, err);
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
  } else if (status) {
    lines.push(`ℹ️ Cập nhật trạng thái đơn: <b>${escapeHtml(status)}</b>`);
  } else {
    // CS gõ tay reply không khớp trạng thái chuẩn -> chuyển nguyên văn
    lines.push("💬 <b>Phản hồi từ CSKH:</b>");
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

  // Ghi lại danh tính Telegram để admin biết bot đang nhắn với ai
  // (chatId là số, nhìn không ra khách nào).
  const from = msg.from || {};
  const tgName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  const known0 = knownUsers.get(chatId);
  if (known0) {
    if (tgName) known0.tgName = tgName;
    if (from.username) known0.tgUsername = from.username;
  }
  pendingTgProfile.set(chatId, { tgName, tgUsername: from.username || null });

  pushLog(chatId, "in", text, null); // tin khách nhắn vào

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
  const iso = t => (t ? new Date(t).toISOString() : null);
  return Array.from(knownUsers.entries())
    .map(([chatId, v]) => ({
      chatId,
      tgName:          v.tgName     || null,
      tgUsername:      v.tgUsername || null,
      username:        v.username,
      transferContent: v.transferContent,
      rootId:          v.rootId,
      lastStatus:      v.lastStatus,
      lastNote:        v.lastNote,
      sentCount:       v.sentCount  || 0,
      lastSentAt:      iso(v.lastSentAt),
      lastSentText:    v.lastSentText || null,
      lastError:       v.lastError    || null,
      lastErrorAt:     iso(v.lastErrorAt),
      updatedAt:       iso(v.updatedAt),
    }))
    .sort((a, b) => (b.lastSentAt || "").localeCompare(a.lastSentAt || ""));
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

// ── Lịch sử tin nhắn ──────────────────────────────────────────────────────────
// chatId để trống = lấy tất cả. Trả về mới nhất trước.
function getLog(chatId, limit) {
  const max = limit || 500;
  let rows = msgLog;
  if (chatId != null && chatId !== "") {
    rows = rows.filter(r => String(r.chatId) === String(chatId));
  }
  return rows.slice(-max).reverse().map(r => ({
    ...r, at: new Date(r.at).toISOString(),
  }));
}

function renderLogHtml(key, chatId) {
  const rows = getLog(chatId, 500);
  const esc = v => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const vn = t => new Date(t).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const q  = encodeURIComponent(key || "");

  const who = chatId
    ? (rows[0] ? `${esc(rows[0].tgName || "—")} · tài khoản <b>${esc(rows[0].username || "—")}</b> · id ${esc(chatId)}`
               : `id ${esc(chatId)}`)
    : "Tất cả khách";

  const body = rows.length ? rows.map(r => `
    <tr class="${r.dir === "in" ? "in" : "out"}${r.error ? " err" : ""}">
      <td class="t">${vn(r.at)}</td>
      <td class="d">${r.dir === "in" ? "⬅ khách" : "➡ bot"}</td>
      ${chatId ? "" : `<td><b>${esc(r.username || "—")}</b><div class="sub">${esc(r.tgName || "")} · id ${esc(r.chatId)}</div></td>`}
      <td>${esc(r.text)}${r.error ? `<div class="badge">${esc(r.error)}</div>` : ""}</td>
    </tr>`).join("") : `<tr><td colspan="4" class="empty">Chưa có tin nhắn nào.</td></tr>`;

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lịch sử tin nhắn bot</title><style>
body{margin:0;padding:20px;background:#f5f6fa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1d2e}
h1{font-size:19px;margin:0 0 4px}
.meta{font-size:12px;color:#9098b8;margin-bottom:14px}
a.back{display:inline-block;margin-bottom:14px;font-size:13px;color:#4f8ef7;text-decoration:none}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.05)}
th{background:#f0f1f6;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5a6080;text-align:left;padding:10px 12px}
td{padding:9px 12px;border-top:1px solid rgba(0,0,0,.06);font-size:13px;vertical-align:top}
td.t{white-space:nowrap;color:#9098b8;font-size:12px}
td.d{white-space:nowrap;font-size:12px;font-weight:600}
tr.in{background:rgba(79,142,247,.05)}
tr.in td.d{color:#4f8ef7}
tr.out td.d{color:#16a870}
tr.err{background:rgba(232,25,44,.05)}
.sub{font-size:11px;color:#9098b8;margin-top:2px}
.badge{display:inline-block;margin-top:4px;background:rgba(232,25,44,.1);color:#e8192c;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:600}
.empty{text-align:center;color:#9098b8;padding:28px}
</style></head><body>
<a class="back" href="/admin/follow/view?key=${q}">← Về danh sách khách</a>
<h1>Lịch sử tin nhắn</h1>
<div class="meta">${who} · ${rows.length} dòng gần nhất · giữ tối đa ${LOG_MAX} dòng</div>
<table>
  <tr><th>Thời gian</th><th>Chiều</th>${chatId ? "" : "<th>Khách</th>"}<th>Nội dung</th></tr>
  ${body}
</table>
</body></html>`;
}

// ── Trang xem nhanh cho admin (GET /admin/follow/view) ────────────────────────
function renderHtml(key) {
  const rows = getAll();
  const q = encodeURIComponent(key || "");
  const esc = v => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const vn = t => t
    ? new Date(t).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
    : "—";

  const totalSent = rows.reduce((n, r) => n + r.sentCount, 0);
  const errCount  = rows.filter(r => r.lastError).length;
  const neverSent = rows.filter(r => r.sentCount === 0).length;

  const body = rows.length ? rows.map(r => `
    <tr class="${r.lastError ? "err" : ""}">
      <td>${esc(r.tgName || "—")}${r.tgUsername ? `<div class="sub">@${esc(r.tgUsername)}</div>` : ""}
          <div class="sub">id ${esc(r.chatId)}</div></td>
      <td><b>${esc(r.username)}</b><div class="sub">${esc(r.transferContent || "—")}</div></td>
      <td>${esc(r.lastStatus || "chờ xử lý")}</td>
      <td class="num">${r.sentCount}</td>
      <td>${vn(r.lastSentAt)}<div class="sub">${esc(r.lastSentText || "")}</div></td>
      <td>${r.lastError ? `<span class="badge">${esc(r.lastError)}</span><div class="sub">${vn(r.lastErrorAt)}</div>` : "—"}</td>
      <td><a class="lnk" href="/admin/follow/log?key=${q}&chat=${esc(r.chatId)}">Xem lịch sử →</a></td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty">Chưa có khách nào liên kết bot.</td></tr>`;

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot theo dõi hóa đơn — nhật ký gửi</title><style>
body{margin:0;padding:20px;background:#f5f6fa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1d2e}
h1{font-size:19px;margin:0 0 4px}
.meta{font-size:12px;color:#9098b8;margin-bottom:14px}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.card{background:#fff;border:1px solid rgba(0,0,0,.07);border-radius:12px;padding:12px 16px;min-width:110px}
.card .n{font-size:22px;font-weight:800}
.card .l{font-size:11px;color:#5a6080;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.05)}
th{background:#f0f1f6;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5a6080;text-align:left;padding:10px 12px}
td{padding:10px 12px;border-top:1px solid rgba(0,0,0,.06);font-size:13px;vertical-align:top}
.sub{font-size:11px;color:#9098b8;margin-top:2px;overflow-wrap:anywhere}
.num{text-align:center;font-weight:700}
tr.err{background:rgba(232,25,44,.04)}
.badge{background:rgba(232,25,44,.1);color:#e8192c;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:600}
.empty{text-align:center;color:#9098b8;padding:28px}
.lnk{color:#4f8ef7;text-decoration:none;font-size:12px;font-weight:600;white-space:nowrap}
.toplnk{display:inline-block;margin-bottom:14px;font-size:13px;color:#4f8ef7;text-decoration:none}
</style></head><body>
<h1>Bot theo dõi hóa đơn — nhật ký gửi</h1>
<div class="meta">Cập nhật ${vn(Date.now())} · tự tải lại mỗi 30 giây</div>
<div class="cards">
  <div class="card"><div class="n">${rows.length}</div><div class="l">Khách liên kết</div></div>
  <div class="card"><div class="n">${totalSent}</div><div class="l">Tin đã gửi</div></div>
  <div class="card"><div class="n">${neverSent}</div><div class="l">Chưa nhận tin</div></div>
  <div class="card"><div class="n" style="color:${errCount ? "#e8192c" : "inherit"}">${errCount}</div><div class="l">Gửi lỗi</div></div>
</div>
<a class="toplnk" href="/admin/follow/log?key=${q}">Xem toàn bộ lịch sử tin nhắn →</a>
<table>
  <tr><th>Khách Telegram</th><th>Tài khoản / Mã CK</th><th>Trạng thái đơn</th><th>Số tin</th><th>Tin gần nhất</th><th>Lỗi</th><th></th></tr>
  ${body}
</table>
<script>setTimeout(function(){location.reload()},30000)</script>
</body></html>`;
}

module.exports = {
  start,
  createFollowLink,
  handleWebhook,
  getAll,
  getLog,
  renderHtml,
  renderLogHtml,
  sendStatusToCustomer,
  // Dùng cho luồng gộp hối thúc + theo dõi (gọi từ server.js)
  getChatIdForToken,
  attachUrgentRoot,
  resolveAlreadyCredited,
};
