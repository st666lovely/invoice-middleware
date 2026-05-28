"use strict";
/**
 * ST666 Internal API Client — Deposit Remark via deposits/search
 */

const axios  = require("axios");
const crypto = require("crypto");
const logger = require("./logger");

const BASE    = process.env.ST666_API_BASE || "https://boapi.bo666st.com/vh7prod-ims/api/v1";
const BO_USER = process.env.ST666_BO_USER  || process.env.BO_USERNAME;
const BO_PASS = process.env.ST666_BO_PASS  || process.env.ST666_BO_PASSWORD || process.env.BO_PASSWORD;

// Threshold chung — đồng bộ với boBrowser.js
const CREDITED_THRESHOLD_MS = 30 * 60 * 1000;

function sha1(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

// ── Token cache + MUTEX ───────────────────────────────────────────────────────
let _token        = null;
let _tokenExpiry  = 0;
let _loginPromise = null;

function parseJwtExpiry(jwt) {
  try {
    const raw     = String(jwt).replace(/^Bearer\s+/i, "");
    const payload = JSON.parse(Buffer.from(raw.split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : Date.now() + 3600000;
  } catch {
    return Date.now() + 3600000;
  }
}

function buildHeaders(token) {
  return {
    "Accept":          "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://bo.bo666st.com",
    "Referer":         "https://bo.bo666st.com/",
    "X-Currency":      "VND2",
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ...(token ? { "Authorization": token } : {}),
  };
}

async function login() {
  if (!BO_USER || !BO_PASS) throw new Error("ST666_BO_USER / ST666_BO_PASS chưa được cấu hình");

  logger.info("ST666 login...");
  const res  = await axios.post(`${BASE}/login`, { userid: BO_USER, password: sha1(BO_PASS) }, {
    headers: buildHeaders(null),
    timeout: 12000,
  });

  const data  = res.data;
  const token = data?.token || data?.accessToken || data?.access_token
             || data?.data?.token || data?.data?.accessToken
             || res.headers?.["x-token-renew"] || res.headers?.["authorization"];

  if (!token) throw new Error("Login OK nhưng không tìm thấy token. Response: " + JSON.stringify(data).slice(0, 200));

  _token       = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  _tokenExpiry = parseJwtExpiry(_token);

  logger.info("ST666 login OK", { user: BO_USER, expiry: new Date(_tokenExpiry).toISOString() });
  return _token;
}

async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 60000) return _token;
  if (_loginPromise) return _loginPromise;
  _loginPromise = login().finally(() => { _loginPromise = null; });
  return _loginPromise;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDateParts(dayRange = 7) {
  const now      = Date.now();
  const todayVN  = new Date(now + 7 * 3600000).toISOString().slice(0, 10);
  const startVN  = new Date(now - dayRange * 86400000 + 7 * 3600000).toISOString().slice(0, 10);
  return {
    dateFrom:  startVN,
    dateTo:    todayVN,
    starttime: new Date(`${startVN}T00:00:00+07:00`).getTime(),
    endtime:   new Date(`${todayVN}T23:59:59+07:00`).getTime(),
  };
}

function normalizeList(raw) {
  if (Array.isArray(raw))              return raw;
  if (Array.isArray(raw?.data))        return raw.data;
  if (Array.isArray(raw?.list))        return raw.list;
  if (Array.isArray(raw?.items))       return raw.items;
  if (Array.isArray(raw?.deposits))    return raw.deposits;
  if (Array.isArray(raw?.records))     return raw.records;
  if (Array.isArray(raw?.data?.list))  return raw.data.list;
  if (Array.isArray(raw?.data?.items)) return raw.data.items;
  return [];
}

function getTime(d) {
  for (const v of [d.deposittime, d.depositTime, d.depositdate, d.depositDate,
                   d.createdate, d.createDate, d.createdAt, d.updateDate, d.updatedate]) {
    if (!v) continue;
    const t = typeof v === "number" ? v : new Date(v).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function pickLatestDeposit(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.filter(Boolean).sort((a, b) => getTime(b) - getTime(a))[0] || list[0];
}

function findRemarkDeep(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return null;
  for (const [key, value] of Object.entries(obj)) {
    const k = key.toLowerCase();
    if ((k === "remarks" || k === "remark" || k.includes("remark")) &&
        value != null && typeof value !== "object") {
      const v = String(value).trim();
      if (v && v !== "-") return v;
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = findRemarkDeep(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractDepositRemark(deposit) {
  if (!deposit) return null;
  return deposit.remarks || deposit.remark || deposit.depositRemark || deposit.depositremark
      || deposit.depositRemarks || deposit.depositremarks
      || deposit.deposit_remark || deposit.deposit_remarks
      || deposit.depositRemarkText || deposit.depositremarktext
      || findRemarkDeep(deposit) || null;
}

// ── Core search ───────────────────────────────────────────────────────────────
async function searchDepositsByStatus(username, statusType, dayRange = 1) {
  const token = await getToken();
  const { dateFrom, dateTo, starttime, endtime } = getDateParts(dayRange);

  const res = await axios.get(`${BASE}/deposits/search`, {
    params: {
      dateFrom, dateTo, starttime, endtime,
      exactmatch: true,
      language:   1,
      limit:      20,
      offset:     0,
      playerid:   username,
      sort:       "DESC",
      sortcolumn: "deposittime",
      statusType,
      timefilter: "deposittime",
      zoneType:   "ASIA_HO_CHI_MINH",
    },
    headers: buildHeaders(token),
    timeout: 15000,
  });

  const list = normalizeList(res.data);
  logger.info("ST666 deposits/search", { username, statusType, dayRange, results: list.length });

  if (!list.length) {
    logger.info("ST666 empty response sample", { sample: JSON.stringify(res.data).slice(0, 800) });
  }

  return list;
}

/** Backward-compat */
async function searchDeposits(username, dayRange = 7) {
  return searchDepositsByStatus(username, "DEPOSIT_AUDIT", dayRange);
}

// ── Deposit lookup cache (5 phút TTL) ─────────────────────────────────────────
const _depositCache    = new Map();
const DEPOSIT_CACHE_TTL = 5 * 60 * 1000;

// Sweep cache mỗi 10 phút — tránh memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of _depositCache) {
    if (now >= val.expiry) _depositCache.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ── Public: fetchPendingRemark ─────────────────────────────────────────────────
async function fetchPendingRemark(username) {
  if (!username) return null;

  try {
    // BƯỚC 1: đã lên điểm chưa?
    const credited = await searchDepositsByStatus(username, "DEPOSIT_RECORD", 1);
    if (credited.length > 0) {
      const latest      = pickLatestDeposit(credited);
      const depositTime = getTime(latest);

      if (Date.now() - depositTime < CREDITED_THRESHOLD_MS) {
        const minutesAgo = Math.floor((Date.now() - depositTime) / 60000);
        logger.info("ST666 deposit already credited", {
          username, depositId: latest?.depositid || null,
          depositAmt: latest?.depositamt || latest?.inputdepositamt, minutesAgo,
        });
        return {
          alreadyCredited: true,
          depositAmt:  latest?.depositamt || latest?.inputdepositamt || 0,
          depositTime,
        };
      }
    }

    // BƯỚC 2: đang chờ duyệt — fallback 1 → 7 → 30 ngày
    let list = await searchDepositsByStatus(username, "DEPOSIT_AUDIT", 1);
    if (!list.length) list = await searchDepositsByStatus(username, "DEPOSIT_AUDIT", 7);
    if (!list.length) list = await searchDepositsByStatus(username, "DEPOSIT_AUDIT", 30);

    if (!list.length) {
      logger.warn("ST666 no deposits found", { username });
      return null;
    }

    const latest = pickLatestDeposit(list);
    const remark = extractDepositRemark(latest);
    logger.info("ST666 deposit selected", {
      username, depositId: latest?.depositid || latest?.depositId || null, remark,
      sample: latest ? JSON.stringify(latest).slice(0, 500) : null,
    });

    return remark || null;

  } catch (err) {
    logger.error("ST666 fetchPendingRemark error", { username, error: err.response?.data || err.message });
    return null;
  }
}

// ── Public: lookupDeposit ─────────────────────────────────────────────────────
async function lookupDeposit(username) {
  if (!username) return { status: "notfound" };

  const key    = username.toLowerCase().trim();
  const cached = _depositCache.get(key);
  if (cached && Date.now() < cached.expiry) {
    logger.info("ST666 deposit cache hit", { username, status: cached.result.status });
    return cached.result;
  }

  let result;
  try {
    // BƯỚC 1: đã lên điểm?
    const credited = await searchDepositsByStatus(username, "DEPOSIT_RECORD", 1);
    if (credited.length > 0) {
      const latest      = pickLatestDeposit(credited);
      const depositTime = getTime(latest);
      const minutesAgo  = Math.floor((Date.now() - depositTime) / 60000);

      if (Date.now() - depositTime < CREDITED_THRESHOLD_MS) {
        result = {
          status:     "credited",
          depositAmt: latest?.depositamt || latest?.inputdepositamt || 0,
          depositTime,
          minutesAgo,
          note: `Đã ghi nhận lúc ${new Date(depositTime).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
        };
        logger.info("ST666 lookup: credited", { username, minutesAgo });
        _depositCache.set(key, { result, expiry: Date.now() + DEPOSIT_CACHE_TTL });
        return result;
      }
    }

    // BƯỚC 2: đang chờ duyệt
    let auditList = await searchDepositsByStatus(username, "DEPOSIT_AUDIT", 1);
    if (!auditList.length) auditList = await searchDepositsByStatus(username, "DEPOSIT_AUDIT", 7);

    if (auditList.length > 0) {
      const latest = pickLatestDeposit(auditList);
      const remark = extractDepositRemark(latest);
      result = {
        status:      "pending",
        remark:      remark || null,
        depositAmt:  latest?.depositamt || latest?.inputdepositamt || 0,
        depositTime: getTime(latest),
      };
      logger.info("ST666 lookup: pending", { username, remark });
      _depositCache.set(key, { result, expiry: Date.now() + DEPOSIT_CACHE_TTL });
      return result;
    }

    result = { status: "notfound" };
    _depositCache.set(key, { result, expiry: Date.now() + 60000 }); // notfound cache 1 phút
    return result;

  } catch (err) {
    logger.error("ST666 lookupDeposit error", { username, error: err.message });
    return { status: "notfound" };
  }
}

function invalidateDepositCache(username) {
  if (username) _depositCache.delete(username.toLowerCase().trim());
}

module.exports = { fetchPendingRemark, lookupDeposit, invalidateDepositCache, searchDeposits };
