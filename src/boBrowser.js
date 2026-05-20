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
      viewport:  { width: 1920, height: 1080 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      locale:    "en-US",
      timezoneId:"Asia/Ho_Chi_Minh",
    });

    // Bắt auth token từ login API response
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
    await page.goto(BO_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3_000);

    // Login
    const userSel = await Promise.race([
      page.waitForSelector("#userid",                       { state: "visible", timeout: 30_000 }),
      page.waitForSelector('[data-testid="login-userid"]',  { state: "visible", timeout: 30_000 }),
      page.waitForSelector('input[placeholder="User Name"]',{ state: "visible", timeout: 30_000 }),
    ]).catch(() => null);

    if (!userSel) throw new Error("Không tìm thấy ô login sau 30s");

    await userSel.fill(BO_USERNAME);
    await page.fill("#password", BO_PASSWORD).catch(() =>
      page.fill('[data-testid="login-password"]', BO_PASSWORD)
    );

    await Promise.all([
      page.waitForURL(url => !url.toString().includes("/login"), { timeout: 20_000 }),
      page.click('button:has-text("Login")'),
    ]);

    logger.info("BO browser logged in", { url: page.url() });

    // Lấy cookies từ browser
    const cookies      = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");

    // Lấy token từ localStorage nếu không bắt được từ response
    if (!authToken) {
      authToken = await page.evaluate(() =>
        localStorage.getItem("token")  ||
        localStorage.getItem("authToken") ||
        localStorage.getItem("access_token") ||
        sessionStorage.getItem("token") ||
        null
      ).catch(() => null);
    }

    logger.info("BO session obtained", {
      cookieCount: cookies.length,
      hasToken:    !!authToken,
    });

    _session = {
      cookieHeader,
      authToken: authToken ? (authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`) : null,
      expiry:    Date.now() + 10 * 60 * 1000,  // 10 phút
    };

    return _session;

  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ── Helper: gọi deposits/search với statusType bất kỳ ────────────────────────
async function searchByStatus(session, username, statusType, dayRange = 1) {
  const now = Date.now();

  // Dùng giờ VN (+07:00) để tính ngày — đúng với cách BO tính
  const todayVN   = new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
  const startVN   = new Date(now - dayRange * 86_400_000 + 7 * 3600_000).toISOString().slice(0, 10);
  const dateFrom  = startVN;
  const dateTo    = todayVN;
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
      exactmatch: true,   // BO dùng exactmatch cho cả DEPOSIT_RECORD và DEPOSIT_AUDIT
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
    const session = await getSession();

    logger.info("BO API search", { username, hasToken: !!session.authToken });

    // ── BƯỚC 1: Check đơn đã lên điểm chưa (DEPOSIT_RECORD trong 30 phút) ──
    const credited = await searchByStatus(session, username, "DEPOSIT_RECORD", 1);
    if (credited.length > 0) {
      const latest     = credited[0]; // đã sort DESC
      const depositTime = latest.deposittime || latest.depositTime || 0;
      const minutesAgo  = Math.floor((Date.now() - depositTime) / 60000);

      if (minutesAgo < 30) {
        logger.info("BO deposit already credited", {
          username,
          depositId: latest?.depositid || null,
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

    // ── BƯỚC 2: Tìm đơn đang chờ duyệt (DEPOSIT_AUDIT) — logic cũ ──
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
    // Reset session để lần sau login lại
    _session = null;
    return null;
  }
}

module.exports = { fetchDepositRemarkByUsername };
