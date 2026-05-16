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
const axios     = require("axios");
const fs        = require("fs");
const path      = require("path");
const FormData  = require("form-data");
const { computeHash, downloadImage, findMatchingInvoice } = require("./imageMatch");
const { resolveChannelGroup, isT3Group } = require("./paymentChannels");
const logger    = require("./logger");

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const GROUP_ID     = process.env.TELEGRAM_GROUP_ID;
const CACHE_TTL    = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE   = path.join(process.cwd(), "telegram_cache.json");

// ── In-memory cache ───────────────────────────────────────────────────────────
let imageCache = new Map();
let textCache  = new Map();
let replyIndex = new Map();

// ── Persist ───────────────────────────────────────────────────────────────────
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      images:  [...imageCache.entries()].map(([k, v]) => [k, { ...v, hash: undefined }]),
      texts:   [...textCache.entries()],
      replies: [...replyIndex.entries()],
    }), "utf8");
  } catch (e) { logger.debug("saveCache error", { error: e.message }); }
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (data.images)  imageCache = new Map(data.images.map(([k, v]) => [k, { ...v, hash: null }]));
    if (data.texts)   textCache  = new Map(data.texts);
    if (data.replies) replyIndex = new Map(data.replies.map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
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
  if (String(msg.chat.id) !== String(GROUP_ID)) return;

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
          // Giữ status/note cũ nếu parse không ra được (tránh overwrite addManualInvoice)
          const existing = imageCache.get(msgId);
          imageCache.set(msgId, {
            message_id:   msgId,
            parent_id:    parentId,
            message_date: msgDate,
            hash,
            file_id:      photo.file_id,
            username:     parsed.username  || existing?.username,
            fullname:     parsed.fullname  || existing?.fullname,
            ck_code:      parsed.ckCode    || existing?.ck_code,
            orderCode:    parsed.orderCode || existing?.orderCode,
            status:       parsed.status    || existing?.status,   // ← không xóa status cũ
            note:         parsed.note      || existing?.note,
            cached_at:    Date.now(),
          });
          saveCache();
          logger.info("Image indexed", { msgId, ck: parsed.ckCode, status: parsed.status || existing?.status });
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

// ── Button definitions ───────────────────────────────────────────────────────
const BUTTONS = [
  { text: "✅ Đã lên điểm",             key: "da_len_diem",    status: "Da len diem" },
  { text: "❌ Chưa nhận được",           key: "chua_nhan_duoc", status: "Chua nhan duoc" },
  { text: "⚠️ NH không thuộc cổng TT",  key: "sai_ngan_hang",  status: "Ngan hang nhan khong thuoc cong thanh toan" },
  { text: "✏️ Khác",                     key: "khac",           status: null },
];

function buildInlineKeyboard(cskhMsgId) {
  return { inline_keyboard: BUTTONS.map(b => ([{ text: b.text, callback_data: `s:${b.key}:${cskhMsgId}` }])) };
}

// ── Pending note state ────────────────────────────────────────────────────────
const pendingNoteMap = new Map();
setInterval(() => {
  const exp = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of pendingNoteMap) if (v.ts < exp) pendingNoteMap.delete(k);
}, 5 * 60 * 1000);

// ── Gửi CSKH + forward T3 với buttons ────────────────────────────────────────
async function sendAndForward({ username, fullname, ckCode, remarks, imageBuffer, imageMimetype }) {
  const caption = [username, fullname || "-", ckCode || "-", remarks || "-",
                   "Yêu cầu hối thúc hóa đơn từ khách", "Chưa nhận được"].join("\n");

  let cskhMsgId;
  if (imageBuffer) {
    const form = new FormData();
    form.append("chat_id", GROUP_ID);
    form.append("caption", caption);
    form.append("photo", imageBuffer, { filename: "invoice.jpg", contentType: imageMimetype || "image/jpeg" });
    const res = await axios.post(`${TELEGRAM_API}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 20_000 });
    cskhMsgId = res.data.result.message_id;
  } else {
    const res = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: GROUP_ID, text: caption });
    cskhMsgId = res.data.result.message_id;
  }

  addManualInvoice({ messageId: cskhMsgId, username, fullname, ckCode: normCK(ckCode),
    orderCode: remarks, status: "Chưa nhận được", note: "Yêu cầu hối thúc hóa đơn từ khách", fileId: null });

  logger.info("Sent to CSKH group", { cskhMsgId, username, remarks });

  const t3GroupId = resolveChannelGroup(remarks);
  if (!t3GroupId) { logger.warn("No T3 group for remarks", { remarks }); return { cskhMsgId, t3GroupId: null }; }

  const fwdRes = await axios.post(`${TELEGRAM_API}/forwardMessage`, {
    chat_id: t3GroupId, from_chat_id: GROUP_ID, message_id: cskhMsgId,
  }).catch(e => { logger.error("Forward T3 failed", { error: e.message, t3GroupId }); return null; });
  if (!fwdRes) return { cskhMsgId, t3GroupId };

  const t3FwdMsgId = fwdRes.data.result.message_id;
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: t3GroupId, text: "📋 Chọn trạng thái xử lý hóa đơn:",
    reply_to_message_id: t3FwdMsgId, reply_markup: buildInlineKeyboard(cskhMsgId),
  }).catch(e => logger.error("Send buttons failed", { error: e.message }));

  const key = `${t3GroupId}:${t3FwdMsgId}`;
  setForwardEntry(key, cskhMsgId, t3GroupId);
  logger.info("Forwarded to T3 with buttons", { t3GroupId, t3FwdMsgId, cskhMsgId });
  return { cskhMsgId, t3GroupId };
}

// ── Xử lý callback query (button press) ──────────────────────────────────────
async function handleCallbackQuery(cbq) {
  const data      = cbq.data || "";
  const t3GroupId = String(cbq.message.chat.id);
  const t3MsgId   = cbq.message.message_id;
  const userId    = String(cbq.from.id);
  const parts     = data.split(":");
  if (parts[0] !== "s" || parts.length < 3) return;
  const statusKey = parts[1];
  const cskhMsgId = Number(parts[2]);
  const btn = BUTTONS.find(b => b.key === statusKey);
  if (!btn) return;

  await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: cbq.id }).catch(() => {});

  const promptRes = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id:             t3GroupId,
    text:                btn.status ? `✍️ [${btn.text}] đã chọn.\nVui lòng nhập ghi chú:` : `✍️ [Khác] - Vui lòng mô tả vấn đề:`,
    reply_to_message_id: t3MsgId,
  }).catch(() => null);

  pendingNoteMap.set(`${t3GroupId}:${userId}`, {
    statusKey, statusText: btn.status, cskhMsgId, t3GroupId, t3MsgId,
    botQuestionMsgId: promptRes?.data?.result?.message_id || null, ts: Date.now(),
  });
  logger.info("Button pressed, awaiting note", { userId, statusKey, cskhMsgId });
}

// ── Xử lý ghi chú từ T3 ──────────────────────────────────────────────────────
async function handleT3Note(msg, pending, pendingKey) {
  const note       = (msg.text || "").trim();
  const statusText = pending.statusText;
  const replyText  = statusText ? (note ? `${note}\n${statusText}` : statusText) : note;

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: pending.t3GroupId, text: `✅ Đã ghi nhận:\n${replyText}`,
    reply_to_message_id: pending.t3MsgId,
  }).catch(e => logger.error("Reply T3 failed", { error: e.message }));

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: GROUP_ID, text: replyText, reply_to_message_id: pending.cskhMsgId,
  }).catch(e => logger.error("Relay CSKH failed", { error: e.message }));

  const { status, note: noteText } = parseReplyText(replyText);
  if (status) {
    const fakeMsgId = Date.now();
    textCache.set(fakeMsgId, { message_id: fakeMsgId, parent_id: pending.cskhMsgId,
      message_date: Date.now(), status, note: noteText || note || null, cached_at: Date.now() });
    addReply(pending.cskhMsgId, fakeMsgId);
    saveCache();
  }
  pendingNoteMap.delete(pendingKey);
  logger.info("T3 note relayed to CSKH", { cskhMsgId: pending.cskhMsgId, status, note });
}

// ── Webhook / Warmup ──────────────────────────────────────────────────────────
async function processUpdate(update) {
  // Handle callback_query (button press from T3 group)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const msg = update.message || update.channel_post;
  if (!msg) return;

  const chatId      = String(msg.chat.id);
  const isMainGroup = chatId === String(GROUP_ID);

  // Tin từ nhóm CSKH chính → index như cũ
  if (isMainGroup) { await indexMessage(msg); return; }

  // Tin từ nhóm T3 → kiểm tra pending note
  if (isT3Group(chatId) && msg.text && msg.from) {
    const userId     = String(msg.from.id);
    const pendingKey = `${chatId}:${userId}`;
    const pending    = pendingNoteMap.get(pendingKey);
    // Chấp nhận nếu reply đúng vào tin bot hỏi hoặc reply vào tin forward
    if (pending && (!pending.botQuestionMsgId || msg.reply_to_message?.message_id === pending.botQuestionMsgId)) {
      await handleT3Note(msg, pending, pendingKey);
      return;
    }
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
      params: { limit: 200, timeout: 10, allowed_updates: ["message"] },
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
  getCacheStats: () => ({ images: imageCache.size, texts: textCache.size, replies: replyIndex.size }),
};

module.exports = { searchInvoiceByAll, telegramService, addRuntimeStatus, getDebugCache, addManualInvoice, sendAndForward };
