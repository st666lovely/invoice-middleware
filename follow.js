"use strict";

/**
 * follow.js — Theo dõi hóa đơn chủ động qua Telegram
 *
 * Mục tiêu: khi hóa đơn khách đã khai chuyển sang "Đã lên điểm", chủ động
 * nhắn Telegram cho khách — không cần khách ngồi F5 trang web kiểm tra.
 *
 * Thiết kế:
 * - Module tách riêng hoàn toàn, KHÔNG đụng vào server.js/telegram.js hiện có,
 *   chỉ dùng lookupDeposit + invalidateDepositCache từ st666api.js (đọc, không sửa).
 * - Logic trạng thái bám sát đúng /api/check-invoice hiện tại: tin thẳng theo
 *   `status` mà lookupDeposit() trả về (đã tự đối chiếu DEPOSIT_AUDIT vs
 *   DEPOSIT_RECORD theo thời gian ở bên trong nó rồi) — KHÔNG thêm lớp so
 *   remark/mã CK, vì mã CK không tồn tại trong BO và khách không biết mã nội
 *   bộ để đối chiếu.
 * - Chỉ thêm 1 cơ chế: chống báo trùng, bằng cách chụp mốc `depositTime` của
 *   lần credited tại thời điểm đăng ký, và chỉ báo khi depositTime đổi khác
 *   mốc đó (tức đơn MỚI lên điểm sau khi khách bắt đầu theo dõi).
 *
 * Dùng bot Telegram RIÊNG (FOLLOW_TG_BOT_TOKEN) — không dùng chung bot CS,
 * để tránh cướp webhook và làm hỏng bot đang chạy.
 */

const axios  = require("axios");
const fs     = require("fs");
const crypto = require("crypto");
const logger = require("./logger");
const { lookupDeposit, invalidateDepositCache } = require("./st666api");
const { addBoCredit } = require("./telegram");

// ── Cấu hình ──────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.FOLLOW_TG_BOT_TOKEN || process.env.URGENT_TG_BOT_TOKEN || null;
const USING_FALLBACK_TOKEN = !process.env.FOLLOW_TG_BOT_TOKEN && !!process.env.URGENT_TG_BOT_TOKEN;

const DB_PATH    = process.env.FOLLOW_DB_PATH   || "./follow-db.json";
const POLL_MS    = parseInt(process.env.FOLLOW_POLL_MS)  || 30_000;
const TTL_MS     = parseInt(process.env.FOLLOW_TTL_MS)   || 24 * 3600_000;
const MAX_SUBS   = parseInt(process.env.FOLLOW_MAX_SUBS) || 500;
const TOKEN_TTL_MS = 30 * 60_000; // link Start hết hạn sau 30 phút nếu chưa bấm
const STAGGER_MS   = 300;         // giãn giữa các username trong 1 vòng poll
const CSKH_URL     = process.env.FOLLOW_CSKH_URL || null;

let BOT_USERNAME = process.env.FOLLOW_TG_BOT_USERNAME || null;
const api = () => `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── State (in-memory + persist file) ────────────────────────────────────────
const pendingTokens = new Map(); // token(12 ký tự) -> { username, transferContent, createdAt, expiresAt }
const subs          = new Map(); // chatId -> subscription object

let _polling    = false;
let _saveTimer  = null;
let _pollTimer  = null;

// ── Persistence ───────────────────────────────────────────────────────────────
function loadDb() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const raw  = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    for (const s of data.subs || []) subs.set(s.chatId, s);
    logger.info("Follow DB loaded", { subs: subs.size });
  } catch (e) {
    logger.error("Follow DB load failed", { error: e.message });
  }
}

function saveDbNow() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify({ subs: Array.from(subs.values()) }, null, 2));
  } catch (e) {
    logger.error("Follow DB save failed", { error: e.message });
  }
}

function saveDbDebounced() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveDbNow, 2_000);
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ── Webhook Telegram (POST /webhook/follow) ────────────────────────────────────
async function handleWebhook(update) {
  const msg = update?.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text   = msg.text.trim();

  if (text.startsWith("/start")) {
    const token = text.split(/\s+/)[1];

    if (!token) {
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

    if (subs.size >= MAX_SUBS && !subs.has(chatId)) {
      return tgSend(chatId, "⚠️ Hệ thống đang quá tải theo dõi, vui lòng thử lại sau ít phút.");
    }

    // Chụp mốc gốc: nếu đơn ĐÃ credited từ trước, lưu depositTime đó lại để
    // không báo nhầm đơn cũ — chỉ báo khi có depositTime MỚI khác mốc này.
    let baseline = { status: "unknown", creditedDepositTime: null };
    try {
      const bo = await lookupDeposit(pending.username);
      baseline.status = bo.status;
      if (bo.status === "credited") baseline.creditedDepositTime = bo.depositTime;
    } catch (e) {
      logger.warn("Follow baseline lookup failed", { username: pending.username, error: e.message });
    }

    subs.set(chatId, {
      chatId,
      username:        pending.username,
      transferContent: pending.transferContent,
      baseline,
      createdAt: Date.now(),
      expiresAt: Date.now() + TTL_MS,
    });
    saveDbDebounced();

    logger.info("Follow subscription created", { chatId, username: pending.username });

    return tgSend(chatId,
      `✅ Đã bắt đầu theo dõi hóa đơn cho tài khoản <b>${escapeHtml(pending.username)}</b>` +
      (pending.transferContent ? ` (mã CK: ${escapeHtml(pending.transferContent)})` : "") +
      `.\n\nHệ thống sẽ tự động nhắn ngay khi hóa đơn được ghi nhận — bạn không cần quay lại web để kiểm tra.\n\n⏱ Theo dõi trong vòng 24 giờ. Gõ /stop để dừng, /status để xem trạng thái.`
    );
  }

  if (text === "/stop") {
    if (subs.has(chatId)) {
      subs.delete(chatId);
      saveDbDebounced();
      return tgSend(chatId, "🛑 Đã dừng theo dõi.");
    }
    return tgSend(chatId, "Bạn hiện không theo dõi hóa đơn nào.");
  }

  if (text === "/status") {
    const sub = subs.get(chatId);
    if (!sub) return tgSend(chatId, "Bạn hiện không theo dõi hóa đơn nào.");
    const mins = Math.max(0, Math.floor((sub.expiresAt - Date.now()) / 60_000));
    return tgSend(chatId, `Đang theo dõi tài khoản <b>${escapeHtml(sub.username)}</b>. Còn khoảng ${mins} phút.`);
  }
}

// ── Vòng poll (mỗi FOLLOW_POLL_MS) ──────────────────────────────────────────────
async function pollOnce() {
  if (_polling) {
    logger.warn("Follow poll bị bỏ qua — vòng trước chưa xong (BO chậm)");
    return;
  }
  _polling = true;

  try {
    const now = Date.now();

    // Xử lý hết hạn 24h trước
    for (const [chatId, sub] of subs) {
      if (now > sub.expiresAt) {
        tgSend(chatId,
          "⏱ Đã dừng theo dõi hóa đơn do quá 24 giờ. Nếu vẫn chưa nhận được tiền, vui lòng liên hệ CSKH để được hỗ trợ.",
          { reply_markup: cskhKeyboard() }
        );
        subs.delete(chatId);
      }
    }

    // Gom theo username — 1 tài khoản chỉ gọi BO 1 lần mỗi vòng dù có nhiều sub
    const byUsername = new Map();
    for (const sub of subs.values()) {
      const key = sub.username.toLowerCase();
      if (!byUsername.has(key)) byUsername.set(key, []);
      byUsername.get(key).push(sub);
    }

    let changed = false;
    let i = 0;
    for (const [username, subList] of byUsername) {
      if (i > 0) await sleep(STAGGER_MS); // giãn cách giữa các username
      i++;

      try {
        invalidateDepositCache(username); // cache 5 phút → phải xoá trước khi poll
        const bo = await lookupDeposit(username);

        if (bo.status !== "credited") continue;

        for (const sub of subList) {
          const alreadyNotified = sub.baseline.creditedDepositTime === bo.depositTime;
          if (alreadyNotified) continue;

          const time = new Date(bo.depositTime).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
          const amt  = Number(bo.depositAmt).toLocaleString("vi-VN");

          tgSend(sub.chatId,
            `✅ Hóa đơn của bạn đã được ghi nhận!\n\n💰 Số tiền: <b>${amt}</b>\n🕒 Lúc: ${time}\n\nCảm ơn bạn đã chờ đợi.`
          );

          try {
            addBoCredit({
              username:    sub.username,
              ckCode:      sub.transferContent || null,
              depositAmt:  bo.depositAmt,
              depositTime: bo.depositTime,
            });
          } catch (e) {
            logger.warn("Follow addBoCredit failed", { username: sub.username, error: e.message });
          }

          sub.baseline.creditedDepositTime = bo.depositTime;
          sub.baseline.status = "credited";
          subs.delete(sub.chatId); // đã báo xong → dừng theo dõi luôn
          changed = true;

          logger.info("Follow notified credited", { chatId: sub.chatId, username, amt, time });
        }
      } catch (e) {
        logger.error("Follow poll lookupDeposit failed", { username, error: e.message });
      }
    }

    if (changed) saveDbDebounced();

  } finally {
    _polling = false;
  }
}

// ── Admin: xem ai đang được theo dõi ────────────────────────────────────────────
function getAll() {
  return Array.from(subs.values()).map(s => ({
    chatId:          s.chatId,
    username:        s.username,
    transferContent: s.transferContent,
    baselineStatus:  s.baseline.status,
    createdAt:       new Date(s.createdAt).toISOString(),
    expiresAt:       new Date(s.expiresAt).toISOString(),
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

  _pollTimer = setInterval(() => {
    pollOnce().catch(e => logger.error("Follow pollOnce crashed", { error: e.message }));
  }, POLL_MS);

  logger.info("Follow poll loop started", { intervalMs: POLL_MS, ttlHours: TTL_MS / 3600_000 });
}

module.exports = { start, createFollowLink, handleWebhook, getAll };
