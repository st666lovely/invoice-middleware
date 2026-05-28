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

const BO_LOGIN_URL = process.env.BO_LOGIN_URL   || "https://bo.bo666st.com/login";
const BO_API_BASE  = process.env.ST666_API_BASE  || "https://boapi.bo666st.com/vh7prod-ims/api/v1";
const BO_USERNAME  = process.env.BO_USERNAME;
const BO_PASSWORD  = process.env.BO_PASSWORD;

// ── Session cache ─────────────────────────────────────────────────────────────
let _session = null;  // { cookieHeader, authToken, expiry }

async function getSession() {
  if (_session && Date.now() < _session.expiry) return _session;

  logger.info("BO browser login for session...");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  let page;
  try {
    const context = await browser.newContext({
      viewport:   { width: 1920, height: 1080 },
      userAgent:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
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

    // ✅ Fix 1: Bỏ waitForTimeout(45s), dùng networkidle thay thế
    await page.goto(BO_LOGIN_URL, { waitUntil: "networkidle", timeout: 60_000 });

    // ✅ Fix 2: Chờ input xuất hiện thay vì chờ thời gian cố định
    const userSel = await Promise.race([
      page.waitForSelector("#userid",                        { state: "visible", timeout: 30_000 }),
      page.waitForSelector('[data-testid="login-userid"]',   { state: "visible", timeout: 30_000 }),
      page.waitForSelector('input[placeholder="User Name"]', { state: "visible", timeout: 30_000 }),
    ]).catch(() => null);

    if (!userSel) {
      // Dump HTML để debug khi không tìm thấy selector
      const html = await page.content().catch(() => "");
      logger.error("Login selector not found", { url: page.url(), htmlSnippet: html.slice(0, 500) });
      throw new Error("Không tìm thấy ô login");
    }

    await userSel.fill(BO_USERNAME);

await page.fill("#password", BO_PASSWORD).catch(() =>
  page.fill('[data-testid="login-password"]', BO_PASSWORD)
);

// ✅ Trigger blur/change events để form "biết" đã nhập xong
await page.keyboard.press("Tab");         // blur khỏi password field
await page.waitForTimeout(500);           // chờ JS xử lý validation

// ✅ Click đúng button
await page.click('button.nrc-button[type="button"]'); // thêm class để chính xác hơn

// Chờ navigation
await Promise.race([
  page.waitForURL(url => !url.toString().includes("/login"), { timeout: 60_000 }),
  page.waitForLoadState("networkidle", { timeout: 60_000 }),
]).catch(async (err) => {
  const currentUrl = page.url();
  logger.warn("waitForURL race timeout", { currentUrl });
  if (currentUrl.includes("/login")) throw err;
});

    // ✅ Fix 3: Tách click và waitForURL, thêm waitForLoadState
    await page.click('button:has-text("Login")');

    // Chờ navigation với fallback
    await Promise.race([
      page.waitForURL(url => !url.toString().includes("/login"), { timeout: 60_000 }),
      page.waitForLoadState("networkidle", { timeout: 60_000 }),
    ]).catch(async (err) => {
      const currentUrl = page.url();
      logger.warn("waitForURL race timeout", { currentUrl });
      // Nếu URL đã rời /login thì vẫn ok
      if (currentUrl.includes("/login")) throw err;
    });

    const finalUrl = page.url();
    if (finalUrl.includes("/login")) {
      throw new Error(`Vẫn ở trang login sau khi click - URL: ${finalUrl}`);
    }

    logger.info("BO browser logged in", { url: finalUrl });

    const cookies      = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");

    if (!authToken) {
      authToken = await page.evaluate(() =>
        localStorage.getItem("token") ||
        localStorage.getItem("authToken") ||
        localStorage.getItem("access_token") ||
        sessionStorage.getItem("token") ||
        null
      ).catch(() => null);
    }

    logger.info("BO session obtained", { cookieCount: cookies.length, hasToken: !!authToken });

    _session = {
      cookieHeader,
      authToken: authToken ? (authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`) : null,
      expiry: Date.now() + 20 * 60 * 1000,
    };

    return _session;

  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ── Login attempt tracking (chống spam login → block tài khoản) ───────────────
let _loginAttempts     = 0;
let _loginCooldownUntil = 0;
const MAX_LOGIN_ATTEMPTS  = 3;
const LOGIN_COOLDOWN_MS   = 10 * 60 * 1000; // 10 phút cooldown nếu fail liên tiếp

async function getSessionSafe() {
  if (_session && Date.now() < _session.expiry) return _session;

  // Kiểm tra cooldown — tránh login liên tục gây khóa tài khoản
  if (Date.now() < _loginCooldownUntil) {
    const waitSec = Math.ceil((_loginCooldownUntil - Date.now()) / 1000);
    throw new Error(`BO login đang cooldown, thử lại sau ${waitSec}s`);
  }

  if (_loginAttempts >= MAX_LOGIN_ATTEMPTS) {
    _loginCooldownUntil = Date.now() + LOGIN_COOLDOWN_MS;
    _loginAttempts = 0;
    logger.error("BO login cooldown activated", { cooldownMinutes: 10 });
    throw new Error("BO login thất bại quá nhiều lần, cooldown 10 phút để tránh bị khóa tài khoản");
  }

  _loginAttempts++;
  logger.warn("BO login attempt", { attempt: _loginAttempts, maxAttempts: MAX_LOGIN_ATTEMPTS });

  try {
    const session = await getSession();
    // Login thành công → reset counter
    _loginAttempts = 0;
    _loginCooldownUntil = 0;
    return session;
  } catch (err) {
    logger.error("BO login attempt failed", {
      attempt: _loginAttempts,
      error: err.message,
    });
    throw err;
  }
}

// ── Helper: gọi deposits/search với statusType bất kỳ ────────────────────────
async function searchByStatus(session, username, statusType, dayRange = 1) {
  const now = Date.now();

  const todayVN  = new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
  const startVN  = new Date(now - dayRange * 86_400_000 + 7 * 3600_000).toISOString().slice(0, 10);
  const dateFrom = startVN;
  const dateTo   = todayVN;
  const starttime = new Date(dateFrom + "T00:00:00+07:00").getTime();
  const endtime   = new Date(dateTo   + "T23:59:59.999+07:00").getTime();

  const headers = {
    "Accept":          "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://bo.bo666st.com",
    "Referer":         "https://bo.bo666st.com/",
    "X-Currency":      "VND2",
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "Cookie":          session.cookieHeader,
    ...(session.authToken ? { "Authorization": session.authToken } : {}),
  };

  const res = await axios.get(`${BO_API_BASE}/deposits/search`, {
    params: {
      dateFrom, dateTo, starttime, endtime,
      playerid:   username,
      exactmatch: true,
      statusType,
      zoneType:   process.env.ST666_ZONE || "ASIA_HO_CHI_MINH",
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

// ── Gọi API trực tiếp với cookies từ browser session ─────────────────────────
async function fetchDepositRemarkByUsername(username) {
  if (!BO_USERNAME || !BO_PASSWORD) {
    throw new Error("BO_USERNAME / BO_PASSWORD chưa được cấu hình");
  }
  if (!username) return null;

  try {
    // ✅ Dùng getSessionSafe thay vì getSession để có cooldown protection
    const session = await getSessionSafe();

    logger.info("BO API search", { username, hasToken: !!session.authToken });

    // ── BƯỚC 1: Check đơn đã lên điểm chưa (DEPOSIT_RECORD trong 30 phút) ──
    const credited = await searchByStatus(session, username, "DEPOSIT_RECORD", 1);
    if (credited.length > 0) {
      const latest      = credited[0];
      const depositTime = latest.deposittime || latest.depositTime || 0;
      const minutesAgo  = Math.floor((Date.now() - depositTime) / 60000);

      logger.info("BO DEPOSIT_RECORD check", {
        username,
        depositId:   latest?.depositid || null,
        depositTime,
        minutesAgo,
        threshold:   30,
        willTrigger: minutesAgo < 30,
      });

      if (minutesAgo < 30) {
        logger.info("BO deposit already credited", {
          username,
          depositId:  latest?.depositid || null,
          depositAmt: latest?.depositamt || latest?.inputdepositamt,
          minutesAgo,
        });

        return {
          alreadyCredited: true,
          depositAmt:  latest?.depositamt || latest?.inputdepositamt || 0,
          depositTime,
        };
      }
    }

    // ── BƯỚC 2: Tìm đơn đang chờ duyệt (DEPOSIT_AUDIT) ──
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

    // ✅ Chỉ reset session nếu lỗi KHÔNG phải cooldown
    // Tránh reset liên tục → login lại → bị khóa tài khoản
    if (!err.message.includes("cooldown")) {
      _session = null;
    }

    return null;
  }
}

module.exports = { fetchDepositRemarkByUsername };
