"use strict";
/**
 * ST666 Internal API Client
 *
 * Mục đích: tìm deposit theo username trên BO,
 *           lấy field "remarks" (= Deposit Remark) điền vào caption bot.
 *
 * Login payload : { userid, password }  — password là SHA1 hash
 * Login path    : POST /login
 *
 * ENV cần thiết:
 *   ST666_API_BASE = https://boapi.bo666st.com/vh7prod-ims/api/v1
 *   ST666_BO_USER  = userid đăng nhập BO (vd: jason666)
 *   ST666_BO_PASS  = mật khẩu gốc (code tự SHA1 trước khi gửi)
 */

const axios  = require("axios");
const crypto = require("crypto");
const logger = require("./logger");

const BASE    = process.env.ST666_API_BASE || "https://boapi.bo666st.com/vh7prod-ims/api/v1";
const BO_USER = process.env.ST666_BO_USER;
const BO_PASS = process.env.ST666_BO_PASS;

function sha1(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

// ── Token cache ───────────────────────────────────────────────────────────────
let _token       = null;
let _tokenExpiry = 0;

function parseJwtExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : Date.now() + 3_600_000;
  } catch { return Date.now() + 3_600_000; }
}

function buildHeaders(token) {
  return {
    "Accept":          "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://bo.bo666st.com",
    "Referer":         "https://bo.bo666st.com/",
    "X-Currency":      "VND2",
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    ...(token ? { "Authorization": token } : {}),
  };
}

async function login() {
  if (!BO_USER || !BO_PASS) throw new Error("ST666_BO_USER / ST666_BO_PASS chưa được cấu hình");

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

  if (!token) throw new Error("Không tìm thấy token. Response: " + JSON.stringify(data).slice(0, 200));

  _token       = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  _tokenExpiry = parseJwtExpiry(token);
  logger.info("ST666 login OK", { expiry: new Date(_tokenExpiry).toISOString() });
  return _token;
}

async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 60_000) return _token;
  return login();
}

// ── Search deposits theo username ─────────────────────────────────────────────
// Params lấy từ Network tab của trang BO thực tế
async function searchDeposits(username, dayRange = 7) {
  const token  = await getToken();
  const zone   = process.env.ST666_ZONE || "ASIA_HO_CHI_MINH";

  // Tính dateFrom / dateTo
  const now     = Date.now();
  const dateFrom = new Date(now - dayRange * 86_400_000).toISOString().split("T")[0];
  const dateTo   = new Date(now + 86_400_000).toISOString().split("T")[0];

  // starttime / endtime: midnight → end-of-day theo giờ VN (UTC+7)
  const starttime = new Date(dateFrom + "T00:00:00+07:00").getTime();
  const endtime   = new Date(dateTo   + "T23:59:59.999+07:00").getTime();

  const params = {
    dateFrom,
    dateTo,
    starttime,
    endtime,
    playerid:    username,
    exactmatch:  true,
    statusType:  "DEPOSIT_AUDIT",
    zoneType:    zone,
    timefilter:  "deposittime",
    sortcolumn:  "deposittime",
    sort:        "DESC",
    limit:       100,
    offset:      0,
    language:    1,
  };

  logger.info("ST666 search request", { url: `${BASE}/deposits/search`, params });

  let res;
  try {
    res = await axios.get(`${BASE}/deposits/search`, {
      params,
      headers: buildHeaders(token),
      timeout: 12_000,
    });
  } catch (e) {
    logger.error("ST666 search HTTP error", {
      status:   e.response?.status,
      data:     JSON.stringify(e.response?.data).slice(0, 300),
      username,
    });
    throw e;
  }

  logger.info("ST666 search response", { status: res.status, dataType: typeof res.data, isArray: Array.isArray(res.data) });

  const raw = res.data;
  if (Array.isArray(raw))           return raw;
  if (Array.isArray(raw?.data))     return raw.data;
  if (Array.isArray(raw?.list))     return raw.list;
  if (Array.isArray(raw?.items))    return raw.items;
  if (Array.isArray(raw?.deposits)) return raw.deposits;
  return [];
}

// ── Deposit gần nhất, ưu tiên pending ────────────────────────────────────────
function latestDeposit(deposits) {
  if (!deposits?.length) return null;
  const pending = deposits.filter(d => d.status === 1 || d.status === 0);
  const pool    = pending.length ? pending : deposits;
  return pool.reduce((a, b) =>
    (b.playerdeposittime || 0) > (a.playerdeposittime || 0) ? b : a, pool[0]);
}

// ── Public ────────────────────────────────────────────────────────────────────
async function fetchOrderInfo(username) {
  if (!username) return null;

  try {
    let deposits = await searchDeposits(username, 7);
    logger.info("ST666 search", { username, found: deposits.length });

    if (!deposits.length) {
      deposits = await searchDeposits(username, 30);
      logger.info("ST666 widened search", { username, found: deposits.length });
    }

    const match = latestDeposit(deposits);
    if (!match) {
      logger.info("ST666 no deposit found", { username });
      return null;
    }

    logger.info("ST666 deposit found", { username, remarks: match.remarks, t3: match.thirdpartypaymentcode });

    return {
      remarks:        match.remarks               || "-",  // Deposit Remark → dòng 4 caption
      thirdPartyCode: match.thirdpartypaymentcode || null, // prefix nhóm T3
      depositid:      match.depositid             || null,
      status:         match.status,
      depositamt:     match.depositamt,
    };

  } catch (err) {
    logger.error("ST666 fetchOrderInfo error", { error: err.message, username });
    return null;
  }
}

module.exports = { fetchOrderInfo };
