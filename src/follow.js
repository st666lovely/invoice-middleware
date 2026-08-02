"use strict";

/**
 * follow.js — Theo dõi hóa đơn chủ động qua Telegram (v2)
 *
 * Thiết kế mới (thay cho polling BO 30s):
 * - Khách bấm "Theo dõi qua Telegram" trên web → mở Telegram → bấm Start.
 * - Ngay khi Start thành công: gửi 1 tin nhắn format chuẩn (giống
 *   addManualInvoice/hối thúc: username / họ tên / mã CK / mã nội bộ / ghi
 *   chú / trạng thái) vào nhóm CS nội bộ (dùng chung URGENT_TG_BOT_TOKEN/
 *   URGENT_TG_GROUP_ID — đúng bot/nhóm mà luồng "hối thúc" đang dùng), đồng
 *   thời gắn liền chatId của khách vào entry đó trong cache của telegram.js
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
const CSKH_URL     = process.env.FOLLOW_CSKH_URL || null;
// Cooldown tra cứu chủ động — tránh khách bấm gửi dồn dập làm spam tin nhắn.
const CHECK_COOLDOWN_MS = 10_000;

let BOT_USERNAME = process.env.FOLLOW_TG_BOT_USERNAME || null;
const api = () => `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── State (in-memory + persist file) ────────────────────────────────────────
const pendingTokens = new Map(); // token(12 ký tự) -> { username, transferContent, createdAt, expiresAt }
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
  for (const [tok, v] of pendingTokens) if (now > v.expiresAt) pendingTokens.delete(tok);

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
    "-", // họ tên — chưa có tại bước khách bấm theo dõi
    transferContent || "-",
    "-", // mã nội bộ — chưa có tại bước này
    "Khách bấm \"Theo dõi qua Telegram\"",
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
    note:         "Khách bấm \"Theo dõi qua Telegram\"",
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
  if (!known || !known.rootId) {
    return tgSend(chatId,
      "👋 Mình chưa có thông tin đơn nào của bạn. Vui lòng vào trang tra cứu hóa đơn, bấm \"Theo dõi qua Telegram\" để bắt đầu liên kết tài khoản."
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
      (result.note ? `\n\n${escapeHtml(result.note)}` : "")
    );
  }

  if (!result.status || result.status === "-") {
    return tgSend(chatId,
      `⏳ Đơn của bạn (tài khoản <b>${escapeHtml(known.username)}</b>) đang chờ CSKH xử lý. Mình sẽ nhắn ngay khi có kết quả, hoặc bạn cứ nhắn lại vào đây bất cứ lúc nào để kiểm tra.`
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
        "👋 Chào bạn. Vui lòng bấm nút \"Theo dõi qua Telegram\" trên trang tra cứu hóa đơn để bắt đầu."
      );
    }

    const pending = pendingTokens.get(token);
    if (!pending) {
      return tgSend(chatId,
        "⚠️ Link theo dõi không hợp lệ hoặc đã hết hạn (30 phút). Vui lòng quay lại trang web và bấm \"Theo dõi qua Telegram\" lại."
      );
    }
    pendingTokens.delete(token); // dùng 1 lần

    const entry = await registerFollowInvoice(chatId, pending.username, pending.transferContent);
    if (!entry) {
      return tgSend(chatId,
        "⚠️ Không thể ghi nhận theo dõi lúc này, vui lòng thử lại sau ít phút hoặc liên hệ CSKH.",
        { reply_markup: cskhKeyboard() }
      );
    }

    rememberUser(chatId, pending.username, pending.transferContent, entry.message_id);
    saveDbDebounced();

    logger.info("Follow subscription created", { chatId, username: pending.username, rootId: entry.message_id });

    return tgSend(chatId,
      `✅ Đã ghi nhận theo dõi hóa đơn cho tài khoản <b>${escapeHtml(pending.username)}</b>` +
      (pending.transferContent ? ` (mã CK: ${escapeHtml(pending.transferContent)})` : "") +
      `.\n\nBộ phận CSKH sẽ xử lý và mình sẽ nhắn ngay cho bạn khi có kết quả — không cần quay lại web để kiểm tra.\n\n` +
      `Bạn cũng có thể nhắn lại vào đây bất cứ lúc nào để mình kiểm tra trạng thái mới nhất, hoặc gõ /status.`
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

module.exports = { start, createFollowLink, handleWebhook, getAll, sendStatusToCustomer };
