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
 
    // Dùng triple-click + type để trigger React onChange đúng cách
    await userSel.click({ clickCount: 3 });
    await userSel.type(BO_USERNAME, { delay: 50 });
 
    const passSel = await page.$('#password') ||
                    await page.$('[data-testid="login-password"]') ||
                    await page.$('input[type="password"]');
    if (passSel) {
      await passSel.click({ clickCount: 3 });
      await passSel.type(BO_PASSWORD, { delay: 50 });
    }
 
    await page.waitForTimeout(500);
 
    // Thử click Login button với nhiều selector khác nhau
    const loginBtn = await page.$('button:has-text("Login")') ||
                     await page.$('button:has-text("login")') ||
                     await page.$('button:has-text("LOGIN")') ||
                     await page.$('button[type="submit"]') ||
                     await page.$('input[type="submit"]');
    if (loginBtn) {
      await loginBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }
 
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
      const html = await page.content().catch(() => "");
      const plainText = html.replace(/<[^>]+>/g, " ").replace(/ +/g, " ").slice(0, 400);
      logger.error("BO login stuck", { url: finalUrl, pageText: plainText });
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
 
async function getSession() {
  if (_session && Date.now() < _session.expiry) return _session;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt > 1) {
        logger.info("BO browser login retry", { attempt });
        await new Promise(r => setTimeout(r, 3000));
      }
      return await _doLogin();
    } catch (err) {
      lastErr = err;
      _session = null;
      logger.warn("BO browser login attempt failed", { attempt, error: err.message });
    }
  }
  throw lastErr;
}
 
 
// ── Helper: gọi deposits/search với statusType bất kỳ ────────────────────────
async function searchByStatus(session, username, statusType, dayRange = 1) {
  const now = Date.now();
  const todayVN   = new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
  const startVN   = new Date(now - dayRange * 86_400_000 + 7 * 3600_000).toISOString().slice(0, 10);
  const dateFrom  = startVN;
  const dateTo    = todayVN;
  const starttime = new Date(dateFrom + "T00:00:00+07:00").getTime();
  const endtime   = new Date(dateTo   + "T23:59:59.999+07:00").getTime();
 
  const headers = {
    "Accept":          "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          _boOrigin,
    "Referer":         _boOrigin + "/",
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
    const session = await getSession();
    logger.info("BO API search", { username, hasToken: !!session.authToken });
 
    // BƯỚC 1: Check đơn đã lên điểm chưa (DEPOSIT_RECORD trong 30 phút)
    const credited = await searchByStatus(session, username, "DEPOSIT_RECORD", 1);
    if (credited.length > 0) {
      const latest      = credited[0];
      const depositTime = latest.deposittime || latest.depositTime || 0;
      const minutesAgo  = Math.floor((Date.now() - depositTime) / 60000);
 
      logger.info("BO DEPOSIT_RECORD check", {
        username, depositId: latest?.depositid || null,
        depositTime, minutesAgo, threshold: 30, willTrigger: minutesAgo < 30,
      });
 
      if (minutesAgo < 30) {
        logger.info("BO deposit already credited", {
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
 
    // BƯỚC 2: Tìm đơn đang chờ duyệt (DEPOSIT_AUDIT)
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
    _session = null;
    return null;
  }
}
 
module.exports = { fetchDepositRemarkByUsername };
