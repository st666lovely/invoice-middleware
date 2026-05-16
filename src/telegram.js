/**
 * Telegram Module v9 — Clean rewrite
 *
 * FORMAT CAPTION (5-6 dòng):
 *   Dòng 1: ID (username)
 *   Dòng 2: Họ tên
 *   Dòng 3: CK code / Mã giao dịch
 *   Dòng 4: Mã nội bộ (không hiển thị với khách)
 *   Dòng 5: Ghi chú tự do (tùy chọn)
 *   Dòng 6: Trạng thái
 *
 * FORMAT REPLY (admin cập nhật trạng thái):
 *   1 dòng  → trạng thái
 *   2+ dòng → dòng trước = ghi chú, dòng cuối = trạng thái
 */

"use strict";
const axios  = require("axios");
const fs     = require("fs");
const path   = require("path");
const { computeHash, downloadImage, findMatchingInvoice } = require("./imageMatch");
const logger = require("./logger");

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const GROUP_ID     = process.env.TELEGRAM_GROUP_ID;
const CSKH_GROUP_ID = process.env.TELEGRAM_CSKH_GROUP_ID || GROUP_ID;
const T3_GROUP_ID   = process.env.TELEGRAM_T3_GROUP_ID || process.env.T3_GROUP_ID;
const T3_PREFIX_MAP = (() => {
  try { return JSON.parse(process.env.T3_PREFIX_MAP || "{}"); }
  catch { return {}; }
})();
const CACHE_TTL    = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE   = path.join(process.cwd(), "telegram_cache.json");

// ── In-memory cache ───────────────────────────────────────────────────────────
let imageCache = new Map();
let textCache  = new Map();
let replyIndex = new Map();
let t3Links    = new Map(); // t3MsgId -> { rootId, csChatId, csMsgId, t3ChatId }
let pendingT3  = new Map(); // userId -> { rootId, t3MsgId, status }

// ── Persist ───────────────────────────────────────────────────────────────────
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      images:  [...imageCache.entries()].map(([k, v]) => [k, { ...v, hash: undefined }]),
      texts:   [...textCache.entries()],
      replies: [...replyIndex.entries()],
      t3Links: [...t3Links.entries()],
    }), "utf8");
  } catch (e) { logger.debug("saveCache error", { error: e.message }); }
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (data.images)  imageCache = new Map(data.images.map(([k, v]) => [k, { ...v, hash: null }]));
    if (data.texts)   textCache  = new Map(data.texts);
    if (data.replies) replyIndex = new Map(data.replies.map(([k, v]) => [Number(k), Array.isArray(v) ? v : [v]]));
    if (data.t3Links) t3Links = new Map(data.t3Links.map(([k, v]) => [Number(k), v]));
    logger.info("Cache loaded", { images: imageCache.size, texts: textCache.size });
  } catch (e) { logger.warn("loadCache error", { error: e.message }); }
}

loadCache();
setInterval(saveCache, 5 * 60 * 1000);

// ── Status map ────────────────────────────────────────────────────────────────
const STATUS_MAP = [
  { kw: "hỗ trợ lên điểm",
    full: "Đã nhận được, anh giúp em click vào telegram CSKH để bên em tiện trao đổi và hỗ trợ lên điểm" },
  { kw: "chuyển sai ngân hàng",
    full: "Chuyển sai ngân hàng nhận, anh giúp em click vào telegram CSKH để bên em tiện trao đổi biết thêm thông tin ạ" },
  { kw: "đã lên điểm",    full: "Đã lên điểm" },
  { kw: "chưa lên điểm",  full: "Chưa lên điểm" },
  { kw: "đã nhận được",   full: "Đã nhận được" },
  { kw: "chưa nhận được", full: "Chưa nhận được" },
  { kw: "đã thanh toán",  full: "Đã thanh toán" },
  { kw: "chờ thanh toán", full: "Chờ thanh toán" },
  { kw: "chờ xác nhận",   full: "Chờ xác nhận thông tin" },
  { kw: "đang xử lý",     full: "Đang xử lý" },
  { kw: "đã xử lý",       full: "Đã xử lý" },
  { kw: "thành công",     full: "Thành công" },
  { kw: "thất bại",       full: "Thất bại" },
  { kw: "đã hủy",         full: "Đã hủy" },
  { kw: "hoàn tiền",      full: "Hóa đơn hoàn tiền" },
  { kw: "lỗi thanh toán", full: "Lỗi thanh toán" },
  { kw: "chưa xác định",  full: "Giao dịch chưa xác định" },
  { kw: "đang kiểm tra",  full: "Đang kiểm tra" },
];

function normText(t) {
  return (t || "").toLowerCase().replace(/[\/\-_.,:;!?()[\]{}]/g, " ").replace(/\s+/g, " ").trim();
}

function detectStatus(text) {
  if (!text) return null;
  const t = normText(text);
  const m = STATUS_MAP.find(s => t.includes(s.kw.toLowerCase()));
  return m ? m.full : null;
}

function normCK(ck) {
  return (ck || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ── Parse caption ─────────────────────────────────────────────────────────────
function parseCaption(text) {
  const empty = { username: null, fullname: null, ckCode: null, orderCode: null, status: null, note: null };
  if (!text) return empty;

const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return empty;

  const username = lines[0] || null;
  const fullname = lines[1] || null;
  const ckCode   = lines[2] ? normCK(lines[2]) : null;

  let orderCode = null;
  let status = null;
  let note = null;

  if (lines.length >= 6) {
    orderCode = lines[3] || null;
    const lastLine = lines[lines.length - 1];
    status = detectStatus(lastLine) || lastLine || null;
    const noteLines = lines.slice(4, -1);
    note = noteLines.length ? noteLines.join(" | ") : null;
  } else if (lines.length === 5) {
    orderCode = "-";
    const lastLine = lines[4];
    status = detectStatus(lastLine) || lastLine || null;
    note = lines[3] || null;
  } else {
    orderCode = lines[3] || null;
    for (let i = lines.length - 1; i >= 2; i--) {
      const s = detectStatus(lines[i]);
      if (s) { status = s; break; }
    }
  }

  return { username, fullname, ckCode, orderCode, status, note };
}

// ── Parse reply ───────────────────────────────────────────────────────────────
function parseReplyText(text) {
  if (!text) return { status: null, note: null };
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { status: null, note: null };

  // Tìm dòng status cuối cùng từ dưới lên
  let statusIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (detectStatus(lines[i])) { statusIdx = i; break; }
  }

  if (statusIdx === -1) return { status: null, note: null };

  const status    = detectStatus(lines[statusIdx]);
  const noteLines = lines.filter((_, i) => i !== statusIdx);
  const note      = noteLines.length > 0 ? noteLines.join(" | ") : null;

  return { status, note };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getLargestPhoto(photos) {
  if (!photos?.length) return null;
  return photos.reduce((a, b) => (a.file_size > b.file_size ? a : b));
}

async function getFileUrl(fileId) {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: fileId }, timeout: 10000 });
    const p = res.data.result?.file_path;
    return p ? `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${p}` : null;
  } catch (e) { return null; }
}


function buildCskhKeyboard() {
  return {
    inline_keyboard: [[
      { text: "✅ Đã lên điểm", callback_data: "cskh:done" },
      { text: "➡️ Cho phép chuyển tiếp", callback_data: "cskh:forward" },
    ]],
  };
}

function buildT3Keyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Đã lên điểm",    callback_data: "t3:status:Đã lên điểm" }],
      [{ text: "❌ Chưa nhận được", callback_data: "t3:status:Chưa nhận được" }],
      [{ text: "⚠️ Sai số tiền",    callback_data: "t3:status:Sai số tiền" }],
      [{ text: "🔄 Sai ngân hàng",  callback_data: "t3:status:Sai ngân hàng" }],
      [{ text: "✏️ Khác",           callback_data: "t3:status:Khác" }],
    ],
  };
}

function pickT3ChatId(orderCode) {
  const code = String(orderCode || "").trim();
  const prefix = code.split(/[-_\s]/)[0]?.toUpperCase() || "";
  return T3_PREFIX_MAP[prefix] || T3_GROUP_ID;
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!callbackQueryId) return;
  await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  }, { timeout: 10000 }).catch(() => {});
}

async function sendTelegramMessage(payload) {
  const res = await axios.post(`${TELEGRAM_API}/sendMessage`, payload, { timeout: 15000 });
  return res.data?.result || null;
}

async function sendTelegramPhoto(payload) {
  const res = await axios.post(`${TELEGRAM_API}/sendPhoto`, payload, { timeout: 20000 });
  return res.data?.result || null;
}

function upsertTextStatus({ msgId, parentId, status, note }) {
  textCache.set(Number(msgId), {
    message_id:   Number(msgId),
    parent_id:    parentId ? Number(parentId) : null,
    message_date: Date.now(),
    status,
    note:         note || null,
    cached_at:    Date.now(),
  });
  if (parentId) addReply(Number(parentId), Number(msgId));
  saveCache();
}

function addReply(parentId, childId) {
  const ch = replyIndex.get(parentId) || [];
  if (!ch.includes(childId)) ch.push(childId);
  replyIndex.set(parentId, ch);
}

// ── Lấy status mới nhất theo msgId cao nhất ───────────────────────────────────
function getLatestStatus(rootId) {
  let best = { status: null, note: null, msgId: -1 };

  function traverse(id) {
    const e = imageCache.get(id) || textCache.get(id);
    if (e?.status && id > best.msgId) {
      best = { status: e.status, note: e.note || null, msgId: id };
    }
    for (const cid of (replyIndex.get(id) || [])) traverse(cid);
  }

  traverse(rootId);
  return best.status ? best : null;
}

// ── Index message ─────────────────────────────────────────────────────────────
async function indexMessage(msg) {
  if (!msg) return;
  if (![String(GROUP_ID), String(CSKH_GROUP_ID), String(T3_GROUP_ID)].includes(String(msg.chat.id))) return;

  const msgId    = msg.message_id;
  const parentId = msg.reply_to_message?.message_id || null;
  const msgDate  = msg.date ? msg.date * 1000 : Date.now();
  const text     = msg.text    || "";
  const caption  = msg.caption || "";

  if (parentId) addReply(parentId, msgId);

  // Tin có ảnh
  const photo = getLargestPhoto(msg.photo);
  if (photo) {
    const parsed = parseCaption(caption);
    logger.info("Caption parsed", { msgId, username: parsed.username, ck: parsed.ckCode, status: parsed.status, note: parsed.note });

    try {
      const url = await getFileUrl(photo.file_id);
      if (url) {
        const buf = await downloadImage(url);
        if (buf) {
          const hash = await computeHash(buf);
          imageCache.set(msgId, {
            message_id:   msgId,
            parent_id:    parentId,
            message_date: msgDate,
            hash,
            file_id:      photo.file_id,
            username:     parsed.username,
            fullname:     parsed.fullname,
            ck_code:      parsed.ckCode,
            orderCode:    parsed.orderCode,
            status:       parsed.status,
            note:         parsed.note,
            cached_at:    Date.now(),
          });
          saveCache();
          logger.info("Image indexed", { msgId, ck: parsed.ckCode, status: parsed.status, note: parsed.note });
        }
      }
    } catch (e) { logger.error("Image index error", { msgId, error: e.message }); }
    return;
  }

  // Tin text (reply)
  const { status, note } = parseReplyText(text);
  if (status || parentId) {
    textCache.set(msgId, {
      message_id:   msgId,
      parent_id:    parentId,
      message_date: msgDate,
      status,
      note,
      cached_at:    Date.now(),
    });
    if (status) {
      saveCache();
      logger.info("Reply indexed", { msgId, parentId, status, note });
    }
  }
}

// ── Tìm theo CK ──────────────────────────────────────────────────────────────
function findByCK(searchCK) {
  const n = normCK(searchCK);
  if (!n || n.length < 4) return null;

  for (const [id, entry] of imageCache) {
    if (Date.now() - entry.cached_at > CACHE_TTL) { imageCache.delete(id); continue; }
    const ck = entry.ck_code || "";
    if (ck === n || ck.includes(n) || n.includes(ck)) {
      logger.info("CK match", { id, ck, search: n });
      return id;
    }
  }
  return null;
}

// ── Main search ───────────────────────────────────────────────────────────────
async function searchInvoiceByAll({ username, fullname, transferContent, imageBuffer }) {
  logger.info("=== SEARCH ===", { username, transferContent, cacheSize: imageCache.size });

  // 1. Tìm theo CK code
  let rootId = findByCK(transferContent);

  // 2. Fallback: so khớp ảnh
  if (!rootId && imageBuffer) {
    const imgs = [...imageCache.values()].filter(img => img.hash);
    logger.info("Image match attempt", { validImages: imgs.length });
    if (imgs.length) {
      const m = await findMatchingInvoice(imageBuffer, imgs);
      if (m) { rootId = m.message_id; logger.info("Image match", { rootId }); }
    }
  }

  if (!rootId) {
    logger.info("NOT FOUND", { transferContent, cacheSize: imageCache.size });
    return { found: false };
  }

  const latest = getLatestStatus(rootId);
  const root   = imageCache.get(rootId);

  // Status: ưu tiên reply mới nhất
  // Note: ưu tiên reply mới nhất, fallback về caption gốc
  const status = latest?.status || root?.status || "Đang xử lý";
  const note   = latest?.note   || root?.note   || null;

  logger.info("FOUND", { rootId, status, note });
  return { found: true, status, note };
}


// ── Manual index invoice bot tự gửi ───────────────────────────────────────────
// Bot API thường không gửi update cho chính tin nhắn bot vừa gửi.
// Server gọi hàm này sau khi gửi hối thúc thành công để đưa hóa đơn vào cache.
function addManualInvoice({ messageId, username, fullname, ckCode, orderCode, status, note, fileId }) {
  const msgId = Number(messageId) || Date.now();
  const entry = {
    message_id:   msgId,
    parent_id:    null,
    message_date: Date.now(),
    hash:         null,
    file_id:      fileId || null,
    username:     username || null,
    fullname:     fullname || null,
    ck_code:      ckCode ? normCK(ckCode) : null,
    orderCode:    orderCode || "-",
    status:       status || "Chưa nhận được",
    note:         note || null,
    cached_at:    Date.now(),
  };

  imageCache.set(msgId, entry);
  saveCache();

  logger.info("Manual urgent invoice indexed", {
    msgId,
    username: entry.username,
    ck: entry.ck_code,
    status: entry.status,
    note: entry.note,
  });

  return entry;
}


async function handleCskhCallback(cb) {
  const msg = cb.message;
  const rootId = Number(msg?.message_id);
  const root = imageCache.get(rootId);
  if (!root) return answerCallbackQuery(cb.id, "Không tìm thấy cache đơn này");

  if (cb.data === "cskh:done") {
    upsertTextStatus({
      msgId: Date.now(),
      parentId: rootId,
      status: "Đã lên điểm",
      note: "CSKH xác nhận đã lên điểm",
    });
    return answerCallbackQuery(cb.id, "Đã cập nhật: Đã lên điểm");
  }

  if (cb.data !== "cskh:forward") return;

  const t3ChatId = pickT3ChatId(root.orderCode);
  if (!t3ChatId) return answerCallbackQuery(cb.id, "Chưa cấu hình TELEGRAM_T3_GROUP_ID/T3_PREFIX_MAP");

  const caption = [
    root.username || "-",
    root.fullname || "-",
    root.ck_code || "-",
    root.orderCode || "-",
    root.note || "Yêu cầu CSKH chuyển tiếp qua T3",
    root.status || "Chưa nhận được",
  ].join("\n");

  let sent;
  if (root.file_id) {
    sent = await sendTelegramPhoto({
      chat_id: t3ChatId,
      photo: root.file_id,
      caption,
      reply_markup: buildT3Keyboard(),
    });
  } else {
    sent = await sendTelegramMessage({
      chat_id: t3ChatId,
      text: caption,
      reply_markup: buildT3Keyboard(),
    });
  }

  if (sent?.message_id) {
    t3Links.set(Number(sent.message_id), {
      rootId,
      csChatId: msg.chat.id,
      csMsgId: msg.message_id,
      t3ChatId,
    });
    addReply(rootId, Number(sent.message_id));
    imageCache.set(Number(sent.message_id), {
      ...root,
      message_id: Number(sent.message_id),
      parent_id: rootId,
      message_date: Date.now(),
      cached_at: Date.now(),
    });
    saveCache();
  }

  return answerCallbackQuery(cb.id, "Đã chuyển tiếp qua T3");
}

async function handleT3Callback(cb) {
  const msg = cb.message;
  const t3MsgId = Number(msg?.message_id);
  const link = t3Links.get(t3MsgId);
  if (!link) return answerCallbackQuery(cb.id, "Không tìm thấy liên kết đơn CSKH");

  const status = cb.data.replace("t3:status:", "").trim();
  pendingT3.set(Number(cb.from.id), { ...link, t3MsgId, status });

  await sendTelegramMessage({
    chat_id: msg.chat.id,
    text: "Vui lòng nhập ghi chú:",
    reply_to_message_id: t3MsgId,
  });

  return answerCallbackQuery(cb.id, "Nhập ghi chú để gửi về CSKH");
}

async function handleT3Reply(msg) {
  const pending = pendingT3.get(Number(msg.from?.id));
  if (!pending) return false;

  const note = (msg.text || msg.caption || "").trim();
  if (!note) return false;

  pendingT3.delete(Number(msg.from.id));

  upsertTextStatus({
    msgId: msg.message_id,
    parentId: pending.rootId,
    status: pending.status,
    note,
  });

  const replyText = [
    "REPLY",
    `Trạng thái: ${pending.status}`,
    `Ghi chú: ${note}`,
  ].join("\n");

  await sendTelegramMessage({
    chat_id: pending.csChatId,
    text: replyText,
    reply_to_message_id: pending.csMsgId,
  });

  return true;
}

async function handleCallbackQuery(cb) {
  if (!cb?.data) return;
  if (cb.data.startsWith("cskh:")) return handleCskhCallback(cb);
  if (cb.data.startsWith("t3:status:")) return handleT3Callback(cb);
}

// ── Webhook / Warmup ──────────────────────────────────────────────────────────
async function processUpdate(update) {
  if (update.callback_query) await handleCallbackQuery(update.callback_query);
  const msg = update.message || update.channel_post;
  if (msg) {
    const handledT3 = await handleT3Reply(msg);
    if (!handledT3) await indexMessage(msg);
  }
}

async function setupWebhook(webhookUrl) {
  const res = await axios.post(`${TELEGRAM_API}/setWebhook`, {
    url: `${webhookUrl}/webhook/telegram`,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  logger.info("Webhook set", { ok: res.data.ok });
}

async function warmupCache(webhookUrl) {
  try {
    logger.info("Warming up cache...");
    await axios.post(`${TELEGRAM_API}/deleteWebhook`, { drop_pending_updates: false });
    logger.info("Webhook deleted temporarily");
    await new Promise(r => setTimeout(r, 1000));

    const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
      params: { limit: 200, timeout: 10, allowed_updates: ["message", "callback_query"] },
      timeout: 20000,
    });

    const updates = [...(res.data.result || [])].sort(
      (a, b) => (a.message?.date || 0) - (b.message?.date || 0)
    );

    let indexed = 0;
    for (const u of updates) {
      if (u.message) { await indexMessage(u.message); indexed++; }
    }
    logger.info(`Warmup: fetched ${updates.length} msgs, indexed ${indexed}, images:${imageCache.size}`);

    await setupWebhook(webhookUrl);
    logger.info("Webhook re-activated after warmup");
  } catch (e) {
    logger.error("Warmup error", { error: e.message });
    try { await setupWebhook(webhookUrl); } catch (_) {}
  }
}

// ── Debug ─────────────────────────────────────────────────────────────────────
function getDebugCache() {
  const images = [...imageCache.entries()].map(([id, e]) => ({
    msgId:     id,
    username:  e.username || null,
    ck_code:   e.ck_code  || null,
    status:    e.status   || null,
    note:      e.note     || null,
    hasHash:   !!e.hash,
    cached_at: new Date(e.cached_at).toISOString(),
  }));
  const texts = [...textCache.entries()].map(([id, e]) => ({
    msgId:  id,
    parent: e.parent_id,
    status: e.status,
    note:   e.note || null,
  }));
  return { images, texts, replyCount: replyIndex.size };
}

function addRuntimeStatus({ kw, full, emoji }) {
  STATUS_MAP.unshift({ kw: kw.toLowerCase(), full, emoji: emoji || "📋" });
  logger.info("Runtime status added", { kw, full });
}

// ── Exports ───────────────────────────────────────────────────────────────────
const telegramService = {
  processUpdate, setupWebhook, warmupCache,
  getCacheStats: () => ({ images: imageCache.size, texts: textCache.size, replies: replyIndex.size, t3Links: t3Links.size }),
  buildCskhKeyboard,
};

module.exports = { searchInvoiceByAll, telegramService, addRuntimeStatus, getDebugCache, addManualInvoice };
