"use strict";
require("dotenv").config();
const express  = require("express");
const axios    = require("axios");
const path     = require("path");
const FormData = require("form-data");
const cors     = require("cors");
const helmet   = require("helmet");
const rateLimit = require("express-rate-limit");
const multer   = require("multer");
const { searchInvoiceByAll, telegramService, addRuntimeStatus, getDebugCache, getInvoiceStats, addManualInvoice, addBoCredit, getBoCreditStats } = require("./telegram");
const { fetchDepositRemarkByUsername } = require("./boBrowser");
const { lookupDeposit, invalidateDepositCache } = require("./st666api");
const follow = require("./follow");
const logger = require("./logger");

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    file.mimetype.startsWith("image/") ? cb(null, true) : cb(new Error("Chỉ chấp nhận file ảnh"), false);
  },
});

// ── App ───────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "20kb" }));
app.use("/webhook", rateLimit({ windowMs: 60000, max: 200, standardHeaders: true, legacyHeaders: false }));

// ── Logs ──────────────────────────────────────────────────────────────────────
const recentLogs = [];
const _origInfo  = logger.info.bind(logger);
const _origError = logger.error.bind(logger);
const _origWarn  = logger.warn.bind(logger);
function pushLog(level, msg, meta) {
  recentLogs.push({ ts: new Date().toISOString(), level, msg, meta: meta || {} });
  if (recentLogs.length > 100) recentLogs.shift();
}
logger.info  = (m, d) => { pushLog("info",  m, d); _origInfo(m,  d); };
logger.error = (m, d) => { pushLog("error", m, d); _origError(m, d); };
logger.warn  = (m, d) => { pushLog("warn",  m, d); _origWarn(m,  d); };

// ── Duplicate transferContent registry ───────────────────────────────────────
const ckRegistry = new Map();

function ckRegister(ck, username) {
  if (ckRegistry.size > 10000) ckRegistry.delete(ckRegistry.keys().next().value);
  const key = ck.toLowerCase().trim();
  if (!ckRegistry.has(key)) {
    ckRegistry.set(key, { username: (username || "").toLowerCase().trim(), time: new Date() });
  }
}

function ckCheckDuplicate(ck, username) {
  const key = ck.toLowerCase().trim();
  const existing = ckRegistry.get(key);
  if (!existing) return false;
  if (existing.username === (username || "").toLowerCase().trim()) return false;
  return true;
}

// ── Urgent dedup ──────────────────────────────────────────────────────────────
const urgentSentSet = new Set();

function urgentNorm(ck) {
  return (ck || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ── Telegram send với retry ───────────────────────────────────────────────────
// Telegram API đôi khi lag → retry tối đa 2 lần trước khi throw
async function sendTgWithRetry(fn, label, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isLast    = i === retries;
      const isTimeout = err.code === "ECONNABORTED" || err.message?.includes("timeout");
      const is5xx     = err.response?.status >= 500;

      if (isLast || (!isTimeout && !is5xx)) {
        throw err; // lỗi không retry được (4xx, auth fail…) → throw ngay
      }

      const delay = 2000 * (i + 1); // 2s, 4s
      logger.warn(`${label} retry ${i + 1}/${retries}`, { error: err.message, delay });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── Routes cơ bản ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

app.get("/my-ip", async (_req, res) => {
  try {
    const r = await axios.get("https://api.ipify.org?format=json", { timeout: 5000 });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Webhook Telegram ──────────────────────────────────────────────────────────
app.post("/webhook/telegram", async (req, res) => {
  try { await telegramService.processUpdate(req.body); }
  catch (e) { logger.error("TG error", { error: e.message }); }
  res.json({ ok: true });
});

// ── Webhook Telegram — bot theo dõi hóa đơn ──────────────────────────────────
app.post("/webhook/follow", async (req, res) => {
  try { await follow.handleWebhook(req.body); }
  catch (e) { logger.error("Follow TG error", { error: e.message }); }
  res.json({ ok: true });
});

// ── Public API — Web tool tra cứu ────────────────────────────────────────────
const checkInvoiceLimit = rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { found: false, error: "Quá nhiều yêu cầu, vui lòng chờ 1 phút" },
  standardHeaders: true, legacyHeaders: false,
});

app.get("/api/check-invoice", (_req, res) => {
  const stats = telegramService.getCacheStats();
  res.json({ ok: true, cache: stats, message: "POST để tra cứu hóa đơn" });
});

app.post("/api/check-invoice", checkInvoiceLimit, upload.single("image"), async (req, res) => {
  const { username, transferContent } = req.body || {};
  const imageBuffer = req.file?.buffer || null;

  if (!username && !transferContent && !imageBuffer) {
    return res.status(400).json({ found: false, error: "Thiếu thông tin tra cứu" });
  }

  logger.info("Web check-invoice", { username: username || "-", ck: transferContent || "-", hasImage: !!imageBuffer });

  if (transferContent && transferContent.trim().length >= 4) {
    if (ckCheckDuplicate(transferContent, username)) {
      logger.warn("Duplicate CK detected", { ck: transferContent, by: username });
      return res.json({ found: false, duplicate: true });
    }
    ckRegister(transferContent, username);
  }

  try {
    // Bước 1: Tìm trong Telegram cache
    const result = await searchInvoiceByAll({
      username:        username        || null,
      fullname:        null,
      transferContent: transferContent || null,
      imageBuffer,
    });

    if (result?.found) {
      return res.json({
        found:    true,
        status:   result.status || "Đang xử lý",
        note:     result.note   || null,
        username: username      || null,
        ck:       transferContent || null,
      });
    }

    // Bước 2+3: Tra BO
    if (username) {
      const bo = await lookupDeposit(username);

      if (bo.status === "credited") {
        const time = new Date(bo.depositTime).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
        const amt  = Number(bo.depositAmt).toLocaleString("vi-VN");
        addBoCredit({ username, ckCode: transferContent, depositAmt: bo.depositAmt, depositTime: bo.depositTime });
        return res.json({
          found: true, status: "Đã lên điểm",
          note: `✅ Đơn nạp ${amt} đã được ghi nhận lúc ${time}`,
          username, ck: transferContent || null,
        });
      }

      if (bo.status === "pending") {
        return res.json({
          found: true, status: "Đang xử lý",
          note: "Hóa đơn đang chờ được duyệt",
          username, ck: transferContent || null,
        });
      }

      // Fallback: boBrowser (Playwright)
      try {
        const boResult = await fetchDepositRemarkByUsername(username, transferContent);
        if (boResult && typeof boResult === "object" && boResult.alreadyCredited) {
          const time = new Date(boResult.depositTime).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
          const amt  = Number(boResult.depositAmt).toLocaleString("vi-VN");
          addBoCredit({ username, ckCode: transferContent, depositAmt: boResult.depositAmt, depositTime: boResult.depositTime });
          return res.json({
            found: true, status: "Đã lên điểm",
            note: `✅ Đơn nạp ${amt} đã được ghi nhận lúc ${time}`,
            username, ck: transferContent || null,
          });
        }
        if (boResult && typeof boResult === "string") {
          return res.json({
            found: true, status: "Đang xử lý",
            note: "Hóa đơn đang chờ được duyệt",
            username, ck: transferContent || null,
          });
        }
      } catch (e) {
        logger.warn("check-invoice boBrowser fallback failed", { error: e.message, username });
      }
    }

    return res.json({ found: false });

  } catch (err) {
    logger.error("Web check-invoice error", { error: err.message });
    return res.json({ found: false, error: "Lỗi hệ thống, vui lòng thử lại" });
  }
});

// ── Public API — Hối thúc hóa đơn qua Telegram ───────────────────────────────
app.post("/api/urgent-invoice", upload.single("image"), async (req, res) => {
  const token  = process.env.URGENT_TG_BOT_TOKEN;
  const chatId = process.env.URGENT_TG_GROUP_ID;

  if (!token || !chatId) {
    logger.error("Urgent invoice config missing", { hasToken: !!token, hasChatId: !!chatId });
    return res.status(500).json({ ok: false, error: "Thiếu cấu hình Telegram urgent bot" });
  }

  const username        = (req.body.username || "-").trim();
  const fullname        = (req.body.fullname || "-").trim();
  const transferContent = (req.body.transferContent || req.body.ck || "-").trim();
  const image           = req.file;
  // Token theo dõi do /api/follow-invoice cấp ngay trước đó — dùng để gắn
  // chatId của khách vào đúng tin hối thúc này.
  const followToken     = (req.body.followToken || "").trim() || null;

  if (!username || username === "-" || !transferContent || transferContent === "-") {
    return res.status(400).json({ ok: false, error: "Thiếu tài khoản hoặc mã giao dịch" });
  }

  const ckKey = urgentNorm(transferContent);
  if (ckKey && urgentSentSet.has(ckKey)) {
    logger.info("Urgent duplicate suppressed", { username, ck: transferContent });
    return res.json({ ok: true });
  }

  // Trả 202 ngay — frontend không bị treo, BO lookup + TG gửi ở background
  res.status(202).json({ ok: true, queued: true });

  setImmediate(async () => {
    try {
      // ── Bước 1: lookupDeposit (API trực tiếp, nhanh, có cache 5p) ──────────
      // Không dùng Playwright trừ khi API không trả về remark
      let orderCode = null;
      try {
        const bo = await lookupDeposit(username);
        if (bo.status === "credited") {
          const time = new Date(bo.depositTime).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
          const amt  = Number(bo.depositAmt).toLocaleString("vi-VN");
          addBoCredit({ username, ckCode: transferContent, depositAmt: bo.depositAmt, depositTime: bo.depositTime });
          logger.info("Deposit already credited (API), skip escalate", { username, amt, time });
          // Không gửi nhóm CS -> báo thẳng khách qua bot theo dõi, huỷ token
          follow.resolveAlreadyCredited(followToken, bo.depositAmt, bo.depositTime);
          return;
        }
        if (bo.status === "pending" && bo.remark) {
          orderCode = bo.remark;
          logger.info("OrderCode from API lookup", { username, orderCode });
        }
      } catch (e) {
        logger.warn("lookupDeposit failed in urgent-invoice bg", { error: e.message, username });
      }

      // ── Bước 2: Fallback Playwright nếu API không có remark ───────────────
      if (!orderCode) {
        try {
          const boResult = await fetchDepositRemarkByUsername(username, transferContent);
          if (boResult && typeof boResult === "object" && boResult.alreadyCredited) {
            const time = new Date(boResult.depositTime).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
            const amt  = Number(boResult.depositAmt).toLocaleString("vi-VN");
            addBoCredit({ username, ckCode: transferContent, depositAmt: boResult.depositAmt, depositTime: boResult.depositTime });
            logger.info("Deposit already credited (Playwright), skip escalate", { username, amt, time });
            follow.resolveAlreadyCredited(followToken, boResult.depositAmt, boResult.depositTime);
            return;
          }
          if (typeof boResult === "string" && boResult) {
            orderCode = boResult;
            logger.info("BO browser deposit remark fetched", { username, orderCode });
          } else {
            logger.warn("BO browser deposit remark not found", { username });
          }
        } catch (e) {
          logger.warn("BO browser fetch failed in bg", { error: e.message, username });
        }
      }

      // orderCode bắt buộc — không có thì KHÔNG gửi TG thiếu data
      if (!orderCode) {
        logger.error("Urgent invoice aborted: orderCode not found", { username, transferContent });
        return;
      }

      // ── Bước 3: Gửi Telegram với orderCode đầy đủ ────────────────────────
      const caption = [
        username, fullname, transferContent,
        orderCode,
        "Yêu cầu hối thúc hóa đơn từ khách",
        "-",
      ].join("\n");

      const cskhReplyMarkup = telegramService.buildCskhKeyboard();
      let tgResult;

      if (image && image.buffer) {
        tgResult = await sendTgWithRetry(async () => {
          const form = new FormData();
          form.append("chat_id", chatId);
          form.append("caption", caption);
          form.append("reply_markup", JSON.stringify(cskhReplyMarkup));
          form.append("photo", image.buffer, {
            filename:    image.originalname || "invoice.jpg",
            contentType: image.mimetype     || "image/jpeg",
          });
          const r = await axios.post(
            "https://api.telegram.org/bot" + token + "/sendPhoto",
            form,
            { headers: form.getHeaders(), timeout: 35_000 }
          );
          return r.data;
        }, "sendPhoto");
      } else {
        tgResult = await sendTgWithRetry(async () => {
          const r = await axios.post(
            "https://api.telegram.org/bot" + token + "/sendMessage",
            { chat_id: chatId, text: caption, reply_markup: cskhReplyMarkup },
            { timeout: 25_000 }
          );
          return r.data;
        }, "sendMessage");
      }

      const sentMsg = tgResult && tgResult.result ? tgResult.result : {};
      const fileId  = sentMsg.photo && sentMsg.photo.length
                      ? sentMsg.photo[sentMsg.photo.length - 1].file_id
                      : null;

      // Khách đã bấm Start xong trước khi tới đây thì gắn luôn chatId
      const followChatId = follow.getChatIdForToken(followToken);

      addManualInvoice({
        messageId: sentMsg.message_id,
        username,  fullname,
        ckCode:    transferContent,
        orderCode,
        status:    "-",
        note:      "Yêu cầu hối thúc hóa đơn từ khách",
        fileId,
        followChatId,
      });

      // Ghi lại tin gốc vào token. Nếu khách bấm Start sau, follow.js sẽ tự
      // gắn chatId vào đúng tin này.
      if (followToken) {
        follow.attachUrgentRoot(followToken, {
          messageId: sentMsg.message_id,
          username, fullname,
          ckCode:    transferContent,
          orderCode,
          status:    "-",
          note:      "Yêu cầu hối thúc hóa đơn từ khách",
          fileId,
        });
      }

      if (ckKey) urgentSentSet.add(ckKey);
      if (username) invalidateDepositCache(username);
      logger.info("Urgent invoice sent", { username, orderCode, tgOk: tgResult && tgResult.ok });

    } catch (bgErr) {
      logger.error("Urgent invoice background failed", {
        error:  bgErr.message,
        tg:     bgErr.response && bgErr.response.data ? bgErr.response.data : null,
        status: bgErr.response && bgErr.response.status ? bgErr.response.status : null,
        username,
      });
    }
  });
});


// ── Public API — Theo dõi hóa đơn qua Telegram ───────────────────────────────
const followLimit = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { ok: false, error: "Quá nhiều yêu cầu, vui lòng chờ 1 phút" },
  standardHeaders: true, legacyHeaders: false,
});

app.post("/api/follow-invoice", followLimit, (req, res) => {
  const username        = ((req.body && req.body.username) || "").trim();
  const transferContent = ((req.body && (req.body.transferContent || req.body.ck)) || "").trim();

  if (!username) return res.status(400).json({ ok: false, error: "Thiếu tên đăng nhập" });

  try {
    const { token, link, expiresInMinutes } = follow.createFollowLink(username, transferContent);
    logger.info("Follow link created", { username, ck: transferContent || "-", token });
    res.json({ ok: true, token, link, expiresInMinutes });
  } catch (e) {
    logger.error("Follow link failed", { error: e.message, username });
    res.status(503).json({ ok: false, error: e.message });
  }
});


// ── Admin API ─────────────────────────────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_API_KEY || "";

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!ADMIN_KEY) return res.status(503).json({ error: "ADMIN_API_KEY chưa được cấu hình" });
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/admin/stats", adminAuth, (_req, res) => {
  res.json({
    ok: true, cache: telegramService.getCacheStats(),
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    timestamp: new Date().toISOString(),
  });
});

app.get("/admin/logs",          adminAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ ok: true, logs: recentLogs.slice(-limit) });
});

app.get("/admin/cache",         adminAuth, (_req, res) => res.json({ ok: true, cache: telegramService.getCacheStats() }));
app.get("/admin/cache/inspect", adminAuth, (_req, res) => res.json({ ok: true, ...getDebugCache() }));
app.get("/admin/invoice-stats", adminAuth, (_req, res) => {
  const stats     = getInvoiceStats();
  const boCredits = getBoCreditStats();
  res.json({ ok: true, ...stats, boCredits });
});

app.get("/admin/follow", adminAuth, (_req, res) => res.json({ ok: true, follows: follow.getAll() }));

app.post("/admin/cache/warmup", adminAuth, async (req, res) => {
  res.json({ ok: true, message: "Đang warmup cache..." });
  try { await telegramService.warmupCache(process.env.PUBLIC_URL); }
  catch (e) { logger.error("Manual warmup failed", { error: e.message }); }
});

app.post("/admin/status/add", adminAuth, (req, res) => {
  const { kw, full, emoji } = req.body;
  if (!kw || !full) return res.status(400).json({ error: "Thiếu kw hoặc full" });
  addRuntimeStatus({ kw, full, emoji: emoji || "📋" });
  res.json({ ok: true, message: "Đã thêm: " + kw });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error("Unhandled", { error: err.message });
  res.status(500).json({ error: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  const PUBLIC_URL = process.env.PUBLIC_URL;

  follow.start(PUBLIC_URL).catch(e => logger.error("Follow start failed", { error: e.message }));

  if (PUBLIC_URL) {
    setTimeout(() => {
      telegramService.warmupCache(PUBLIC_URL)
        .then(() => logger.info("Cache warmup complete"))
        .catch(e => logger.error("Cache warmup failed", { error: e.message }));
    }, 2000);
  } else {
    logger.warn("PUBLIC_URL not set, skipping cache warmup");
  }
});

module.exports = app;
