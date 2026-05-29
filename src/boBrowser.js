"use strict";

/**
 * BO Browser — login qua Playwright lấy cookies,
 * sau đó dùng axios gọi API trực tiếp với cookies đó.
 */

const axios  = require("axios");
const logger = require("./logger");

let chromium;
try {
  const { chromium: ec } = require("playwright-extra");
  const stealth = require("puppeteer-extra-plugin-stealth")();
  ec.use(stealth);
  chromium = ec;
} catch {
  chromium = require("playwright").chromium;
}

const BO_LOGIN_URL = process.env.BO_LOGIN_URL  || "https://bo.da77ae888.com/login";
const BO_API_BASE  = process.env.AE888_API_BASE || "https://boapi.da77ae888.com/ae888-ims/api/v1";
const BO_USERNAME  = process.env.BO_USERNAME;
const BO_PASSWORD  = process.env.BO_PASSWORD;

// Threshold chung — đồng bộ với st666api.js
const CREDITED_THRESHOLD_MS = 120 * 60 * 1000; // 120 phút

// ── Session cache + MUTEX ─────────────────────────────────────────────────────
let _session      = null;
let _loginPromise = null;

async function getSession() {
  if (_session && Date.now() < _session.expiry) return _session;
  if (_loginPromise) {
    logger.info("BO login already in progress, waiting...");
    return _loginPromise;
  }
  _loginPromise = _doLogin().finally(() => { _loginPromise = null; });
  return _loginPromise;
}

async function _doLogin() {
  logger.info("BO browser login for session...");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  let page;
  try {
    const context = await browser.newContext({
      viewport:   { width: 1920, height: 1080 },
      userAgent:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale:     "en-US",
      timezoneId: "Asia/Ho_Chi_Minh",
    });

    let authToken = null;
    context.on("response", async (resp) => {
      try {
        if (resp.url().includes("/login") && resp.status() === 200) {
          const json = await resp.json().catch(() => null);
          if (json) {
            authToken = json?.token || json?.accessToken || json?.access_token
                     || json?.data?.token || json?.data?.accessToken
                     || resp.headers()?.["x-token-renew"]
                     || resp.headers()?.["authorization"];
          }
        }
      } catch {}
    });

    page = await context.newPage();
    await page.goto(BO_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_000);

    const userSel = await Promise.race([
      page.waitForSelector("#userid",                        { state: "visible", timeout: 30_000 }),
      page.waitForSelector('[data-testid="login-userid"]',   { state: "visible", timeout: 30_000 }),
      page.waitForSelector('input[placeholder="User Name"]', { state: "visible", timeout: 30_000 }),
    ]).catch(() => null);

    if (!userSel) {
      await page.screenshot({ path: "/tmp/bo-no-input.png" }).catch(() => {});
      throw new Error("Không tìm thấy ô login username");
    }

    await userSel.fill(BO_USERNAME);
    await page.fill("#password", BO_PASSWORD).catch(() =>
      page.fill('[data-testid="login-password"]', BO_PASSWORD)
    );
    await page.waitForTimeout(500);

    // Button DOM: <button class="nrc-button" type="button">Login</button>
    // type="button" — React SPA, KHÔNG trigger browser navigation
    // → dùng waitUntil:"commit" thay vì "load"
    await page.click("button.nrc-button");

    const result = await Promise.race([
      page.waitForURL(
        url => !url.toString().includes("/login"),
        { timeout: 60_000, waitUntil: "commit" }
      ).then(() => "success"),

      page.waitForFunction(
        () => {
          const el = document.querySelector("h5.errormsg");
          return el && el.textContent?.trim().length > 0;
        },
        { timeout: 60_000 }
      ).then(() => "error"),
    ]).catch(err => {
      logger.warn("BO waitForURL + errormsg both timed out", { error: err.message });
      return "timeout";
    });

    await page.screenshot({ path: "/tmp/bo-after-login.png" }).catch(() => {});

    if (result === "error") {
      const errText = await page
        .$eval("h5.errormsg", el => el.textContent?.trim())
        .catch(() => "unknown error");
      throw new Error(`BO login thất bại: "${errText}"`);
    }

    if (result === "timeout" || page.url().includes("/login")) {
      throw new Error(`BO login timeout — vẫn ở /login sau 60s (url: ${page.url()})`);
    }

    logger.info("BO browser logged in", { url: page.url() });

    const cookies      = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");

    if (!authToken) {
      authToken = await page.evaluate(() =>
        localStorage.getItem("token")        ||
        localStorage.getItem("authToken")     ||
        localStorage.getItem("access_token")  ||
        sessionStorage.getItem("token")       ||
        null
      ).catch(() => null);
    }

    logger.info("BO session obtained", { cookieCount: cookies.length, hasToken: !!authToken });

    _session = {
      cookieHeader,
      authToken: authToken
        ? (authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`)
        : null,
      expiry: Date.now() + 20 * 60 * 1000,
    };

    return _session;

  } catch (err) {
    const isAuthFailure = err.message?.includes("BO login thất bại");
    if (isAuthFailure) {
      logger.error("BO login auth failure — kiểm tra credentials hoặc tài khoản bị khóa", { error: err.message });
      _session = null;
    } else {
      logger.warn("BO login network/timeout error — giữ session cũ nếu còn hạn", { error: err.message });
    }
    throw err;

  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ── Helper: gọi deposits/search ───────────────────────────────────────────────
async function searchByStatus(session, username, statusType, dayRange = 1) {
  const now       = Date.now();
  const todayVN   = new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
  const startVN   = new Date(now - dayRange * 86_400_000 + 7 * 3600_000).toISOString().slice(0, 10);
  const dateFrom  = startVN;
  const dateTo    = todayVN;
  const starttime = new Date(dateFrom + "T00:00:00+07:00").getTime();
  const endtime   = new Date(dateTo   + "T23:59:59.999+07:00").getTime();

  const headers = {
    "Accept":          "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://bo.da77ae888.com",
    "Referer":         "https://bo.da77ae888.com/",
    "X-Currency":      "VND2",
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Cookie":          session.cookieHeader,
    ...(session.authToken ? { "Authorization": session.authToken } : {}),
  };

  const res = await axios.get(`${BO_API_BASE}/deposits/search`, {
    params: {
      dateFrom, dateTo, starttime, endtime,
      playerid:   username,
      exactmatch: true,
      statusType,
      zoneType:   process.env.AE888_ZONE || "ASIA_HO_CHI_MINH",
      timefilter: "deposittime",
      sortcolumn: "deposittime",
      sort:       "DESC",
      limit:      20,
      offset:     0,
      language:   1,
    },
    headers,
    timeout: 15_000,
  });

  const raw  = res.data;
  const list = Array.isArray(raw)        ? raw
             : Array.isArray(raw?.data)  ? raw.data
             : Array.isArray(raw?.list)  ? raw.list
             : Array.isArray(raw?.items) ? raw.items
             : [];

  logger.info("BO API result", { username, statusType, count: list.length });
  return list;
}

// ── Helper: kiểm tra đơn bị huỷ/cancel ──────────────────────────────────────
// Status codes từ BO (số nguyên) — chỉ thêm khi đã XÁC NHẬN từ raw log:
//   3 = Approved  ← ĐÃ LÊN ĐIỂM, KHÔNG filter
//   5 = Cancel    ← xác nhận từ raw log
// KHÔNG đoán mò — chưa xác nhận thì không thêm vào
const CANCELLED_STATUS_CODES = new Set([5]);

function isCancelledDeposit(d) {
  // Status là số (trường hợp thực tế của BO này)
  if (typeof d.status === "number") {
    return CANCELLED_STATUS_CODES.has(d.status);
  }
  // Fallback: status là string (phòng trường hợp API đổi format)
  const s = (d.status || d.depositstatus || d.statusname || "").toString().toLowerCase().trim();
  return ["cancel", "cancelled", "reject", "rejected", "failed", "fail", "void", "refund"].includes(s);
}

// ── Public ────────────────────────────────────────────────────────────────────
async function fetchDepositRemarkByUsername(username) {
  if (!BO_USERNAME || !BO_PASSWORD) throw new Error("BO_USERNAME / BO_PASSWORD chưa được cấu hình");
  if (!username) return null;

  try {
    const session = await getSession();
    logger.info("BO API search", { username, hasToken: !!session.authToken });

    // DEPOSIT_RECORD đã được lookupDeposit() (ae888api/st666api) check trước rồi.
    // boBrowser chỉ lấy remarks từ DEPOSIT_AUDIT — không gọi BO 2 lần.
    const list = await searchByStatus(session, username, "DEPOSIT_AUDIT", 7);
    if (list.length > 0 && list[0]?.remarks) return list[0].remarks;

    logger.warn("BO deposit remark not found", { username });
    return null;

  } catch (err) {
    logger.error("BO fetchDepositRemark failed", {
      username,
      error:  err.message,
      status: err.response?.status,
      data:   JSON.stringify(err.response?.data || {}).slice(0, 200),
    });
    const isAuthFailure = err.message?.includes("BO login thất bại");
    const is401 = err.response?.status === 401;
    if (isAuthFailure || is401) {
      logger.warn("BO session reset due to auth failure/401", { is401, isAuthFailure });
      _session = null;
    }
    return null;
  }
}

function invalidateSession() {
  _session = null;
  logger.info("BO session invalidated (forced re-login on next call)");
}

module.exports = { fetchDepositRemarkByUsername, getSession, invalidateSession };
