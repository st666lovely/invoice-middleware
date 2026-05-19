"use strict";
/**
 * ST666 Internal API Client — Deposit Remark via deposits/search
 *
 * Endpoint thật:
 * GET /deposits/search
 *
 * Query chính xác:
 * - playerid=<username>
 * - exactmatch=true
 * - statusType=DEPOSIT_AUDIT
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

let _token = null;
let _tokenExpiry = 0;

function parseJwtExpiry(jwt) {
  try {
    const raw = String(jwt).replace(/^Bearer\s+/i, "");
    const payload = JSON.parse(Buffer.from(raw.split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : Date.now() + 3600000;
  } catch {
    return Date.now() + 3600000;
  }
}

function buildHeaders(token) {
  return {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://bo.bo666st.com",
    "Referer": "https://bo.bo666st.com/",
    "X-Currency": "VND2",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    ...(token ? { "Authorization": token } : {}),
  };
}

async function login() {
  if (!BO_USER || !BO_PASS) {
    throw new Error("ST666_BO_USER / ST666_BO_PASS chưa được cấu hình");
  }

  logger.info("ST666 login...");

  const res = await axios.post(
    `${BASE}/login`,
    {
      userid: BO_USER,
      password: sha1(BO_PASS),
    },
    {
      headers: buildHeaders(null),
      timeout: 12000,
    }
  );

  const data = res.data;
  const token = data?.token
             || data?.accessToken
             || data?.access_token
             || data?.data?.token
             || data?.data?.accessToken
             || res.headers?.["x-token-renew"]
             || res.headers?.["authorization"];

  if (!token) {
    throw new Error("Login OK nhưng không tìm thấy token. Response: " + JSON.stringify(data).slice(0, 200));
  }

  _token = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  _tokenExpiry = parseJwtExpiry(_token);

  logger.info("ST666 login OK", {
    user: BO_USER,
    expiry: new Date(_tokenExpiry).toISOString(),
  });

  return _token;
}

async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 60000) return _token;
  return login();
}

function getDateParts(dayRange = 7) {
  const now = Date.now();
  const start = new Date(now - dayRange * 86400000);
  const end = new Date(now + 86400000);

  const dateFrom = start.toISOString().slice(0, 10);
  const dateTo = end.toISOString().slice(0, 10);

  const starttime = new Date(`${dateFrom}T00:00:00+07:00`).getTime();
  const endtime = new Date(`${dateTo}T23:59:59+07:00`).getTime();

  return { dateFrom, dateTo, starttime, endtime };
}

function normalizeList(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.list)) return raw.list;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.deposits)) return raw.deposits;
  if (Array.isArray(raw?.records)) return raw.records;
  if (Array.isArray(raw?.data?.list)) return raw.data.list;
  if (Array.isArray(raw?.data?.items)) return raw.data.items;
  if (Array.isArray(raw?.data?.records)) return raw.data.records;
  return [];
}

async function searchDeposits(username, dayRange = 7) {
  const token = await getToken();
  const { dateFrom, dateTo, starttime, endtime } = getDateParts(dayRange);

  const res = await axios.get(`${BASE}/deposits/search`, {
    params: {
      dateFrom,
      dateTo,
      endtime,
      exactmatch: true,
      language: 1,
      limit: 100,
      offset: 0,

      // Đúng theo URL BO gửi:
      playerid: username,

      sort: "DESC",
      sortcolumn: "deposittime",
      starttime,
      statusType: "DEPOSIT_AUDIT",
      timefilter: "deposittime",
      zoneType: "ASIA_HO_CHI_MINH",
    },
    headers: buildHeaders(token),
    timeout: 15000,
  });

  const list = normalizeList(res.data);

  logger.info("ST666 deposits/search", {
    username,
    dayRange,
    results: list.length,
  });

  if (!list.length) {
    logger.info("ST666 empty response sample", {
      sample: JSON.stringify(res.data).slice(0, 800),
    });
  }

  return list;
}

function getTime(d) {
  const values = [
    d.deposittime,
    d.depositTime,
    d.depositdate,
    d.depositDate,
    d.createdate,
    d.createDate,
    d.createdAt,
    d.updateDate,
    d.updatedate,
  ];

  for (const v of values) {
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
    const isRemarkKey =
      k === "remarks" ||
      k === "remark" ||
      k === "depositremark" ||
      k === "depositremarks" ||
      k === "deposit_remark" ||
      k === "deposit_remarks" ||
      k.includes("remark");

    if (isRemarkKey && value !== null && value !== undefined && typeof value !== "object") {
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

  return deposit.remarks
      || deposit.remark
      || deposit.depositRemark
      || deposit.depositremark
      || deposit.depositRemarks
      || deposit.depositremarks
      || deposit.deposit_remark
      || deposit.deposit_remarks
      || deposit.depositRemarkText
      || deposit.depositremarktext
      || findRemarkDeep(deposit)
      || null;
}

async function fetchPendingRemark(username) {
  if (!username) return null;

  try {
    let list = await searchDeposits(username, 1);
    if (!list.length) list = await searchDeposits(username, 7);
    if (!list.length) list = await searchDeposits(username, 30);

    if (!list.length) {
      logger.warn("ST666 no deposits found", { username });
      return null;
    }

    const latest = pickLatestDeposit(list);
    const remark = extractDepositRemark(latest);

    logger.info("ST666 deposit selected", {
      username,
      depositId: latest?.depositid || latest?.depositId || null,
      remark,
      keys: latest ? Object.keys(latest).slice(0, 80) : [],
      sample: latest ? JSON.stringify(latest).slice(0, 1000) : null,
    });

    return remark || null;
  } catch (err) {
    logger.error("ST666 fetchPendingRemark error", {
      username,
      error: err.response?.data || err.message,
    });
    return null;
  }
}

module.exports = { fetchPendingRemark };
