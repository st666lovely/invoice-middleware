"use strict";
/**
 * ST666 Internal API Client
 *
 * Base  : https://boapi.bo666st.com/vh7prod-ims/api/v1
 * Auth  : JWT Bearer — tự động login + refresh khi hết hạn
 * Dùng  : fetchPendingRemark(username) → remarks string của đơn pending
 *
 * ENV cần thiết:
 *   ST666_API_BASE = https://boapi.bo666st.com/vh7prod-ims/api/v1
 *   ST666_BO_USER  = userid đăng nhập admin panel
 *   ST666_BO_PASS  = mật khẩu gốc (code tự SHA1 trước khi gửi)
 */

const axios  = require("axios");
const crypto = require("crypto");
const logger = require("./logger");

const BASE    = process.env.ST666_API_BASE || "https://boapi.bo666st.com/vh7prod-ims/api/v1";
const BO_USER = process.env.ST666_BO_USER;
const BO_PASS = process.env.ST666_BO_PASS;

// SHA1 hash password
function sha1(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

// ── Token cache ───────────────────────────────────────────────────────────────
let _token        = null;
let _tokenExpiry  = 0;

function parseJwtExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : Date.now() + 3_600_000;
  } catch { return Date.now() + 3_600_000; }
}

// ── Headers mặc định ─────────────────────────────────────────────────────────
function buildHeaders(token) {
  return {
    "Accept":           "*/*",
    "Accept-Language":  "en-US,en;q=0.9",
    "Origin":           "https://bo.bo666st.com",
    "Referer":          "https://bo.bo666st.com/",
    "X-Currency":       "VND2",
    "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    ...(token ? { "Authorization": token } : {}),
  };
}

// ── Login + lấy JWT ───────────────────────────────────────────────────────────
async function login() {
  if (!BO_USER || !BO_PASS) throw new Error("ST666_BO_USER / ST666_BO_PASS chưa được cấu hình");

  logger.info("ST666 login...");
  const res = await axios.post(
    `${BASE}/login`,
    { userid: BO_USER, password: sha1(BO_PASS) },
    { headers: buildHeaders(null), timeout: 12_000 }
  );

  const data  = res.data;
  const token = data?.token
             || data?.accessToken
             || data?.access_token
             || data?.data?.token
             || data?.data?.accessToken
             || res.headers?.["x-token-renew"]
             || res.headers?.["authorization"];

  if (!token) throw new Error("Login OK nhưng không tìm thấy token. Response: " + JSON.stringify(data).slice(0, 200));

  _token       = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  _tokenExpiry = parseJwtExpiry(token);
  logger.info("ST666 login OK", { user: BO_USER, expiry: new Date(_tokenExpiry).toISOString() });
  return _token;
}

// Lấy token hợp lệ — tự refresh nếu sắp hết hạn (<60s)
async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 60_000) return _token;
  return login();
}

// ── Search deposits theo username ─────────────────────────────────────────────
async function searchDeposits(username, dayRange = 7) {
  const token = await getToken();

  const now      = Date.now();
  const dateFrom = new Date(now - dayRange * 86_400_000).toISOString().split("T")[0];
  const dateTo   = new Date(now + 86_400_000).toISOString().split("T")[0];

  const res = await axios.get(`${BASE}/deposits/search`, {
    params: {
      dateFrom,
      dateTo,
      playerid:   username,
      statusType: "DEPOSIT_AUDIT",
      language:   1,
      getImage:   false,
    },
    headers: buildHeaders(token),
    timeout: 12_000,
  });

  const raw = res.data;
  if (Array.isArray(raw))           return raw;
  if (Array.isArray(raw?.data))     return raw.data;
  if (Array.isArray(raw?.list))     return raw.list;
  if (Array.isArray(raw?.items))    return raw.items;
  if (Array.isArray(raw?.deposits)) return raw.deposits;
  return [];
}

// ── Check xem deposit có đang pending hoặc expired không ─────────────────────
// status = 1 (pending) | 2 (expired) — tuỳ BO system
function isPendingOrExpired(deposit) {
  if (deposit.status === 1 || deposit.status === "1") return true;
  if (deposit.status === 2 || deposit.status === "2") return true;
  const st = (deposit.statusType || deposit.statusEnum || "").toLowerCase();
  return st.includes("pending") || st.includes("expired");
}

// ── Public: lấy remark của đơn pending mới nhất theo username ─────────────────
async function fetchPendingRemark(username) {
  if (!username) return null;

  try {
    let deposits = await searchDeposits(username, 7);

    // Nếu không có gì → mở rộng 30 ngày
    if (!deposits.length) {
      deposits = await searchDeposits(username, 30);
    }

    logger.info("ST666 search", { username, total: deposits.length });

    // Lọc đơn pending hoặc expired
    const pending = deposits.filter(isPendingOrExpired);

    if (!pending.length) {
      logger.info("ST666 no pending/expired deposit", { username });
      return null;
    }

    // Lấy đơn pending mới nhất (index 0 — API thường trả về mới → cũ)
    const latest = pending[0];

    logger.info("ST666 pending found", {
      playerid:  latest.playerid,
      depositId: latest.depositid,
      remarks:   latest.remarks,
    });

    return latest.remarks || null;

  } catch (err) {
    logger.error("ST666 fetchPendingRemark error", { error: err.message, username });
    return null;
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = { fetchPendingRemark };
