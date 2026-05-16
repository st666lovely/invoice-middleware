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
    const cookies     = await context.cookies();
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

// ── Gọi API trực tiếp với cookies từ browser session ─────────────────────────
async function fetchDepositRemarkByUsername(username) {
  if (!BO_USERNAME || !BO_PASSWORD) {
    throw new Error("BO_USERNAME / BO_PASSWORD chưa được cấu hình");
  }
  if (!username) return null;

  try {
    const session = await getSession();

    const now      = Date.now();
    const dateFrom = new Date(now - 7 * 86_400_000).toISOString().split("T")[0];
    const dateTo   = new Date(now + 86_400_000).toISOString().split("T")[0];
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

    const baseParams = {
      dateFrom, dateTo, starttime, endtime,
      playerid:   username,
      exactmatch: true,
      zoneType:   process.env.ST666_ZONE || "ASIA_HO_CHI_MINH",
      timefilter: "deposittime",
      sortcolumn: "deposittime",
      sort:       "DESC",
      limit:      100,
      offset:     0,
      language:   1,
    };

    logger.info("BO API search both pages", { username });

    // Gọi song song: depositAudit (pending) + deposit (đã lên điểm)
    const [auditRes, depositRes] = await Promise.allSettled([
      axios.get(`${BO_API_BASE}/deposits/search`, {
        params:  { ...baseParams, statusType: "DEPOSIT_AUDIT" },
        headers, timeout: 15_000,
      }),
      axios.get(`${BO_API_BASE}/deposits/search`, {
        params:  { ...baseParams, statusType: "DEPOSIT" },
        headers, timeout: 15_000,
      }),
    ]);

    const parseList = (res) => {
      if (res.status !== "fulfilled") return [];
      const raw = res.value.data;
      return Array.isArray(raw)        ? raw
           : Array.isArray(raw?.data)  ? raw.data
           : Array.isArray(raw?.list)  ? raw.list
           : Array.isArray(raw?.items) ? raw.items
           : [];
    };

    const auditList   = parseList(auditRes);
    const depositList = parseList(depositRes);

    logger.info("BO API result", {
      username,
      auditCount:   auditList.length,
      depositCount: depositList.length,
    });

    // Ưu tiên depositAudit (pending) trước, sau đó deposit (đã xử lý)
    const match = auditList.find(d => d.remarks)
               || depositList.find(d => d.remarks)
               || auditList[0]
               || depositList[0];

    if (match) {
      // Detect Approved: text-based (DOM shows "Approved") 
      const statusFields = [match.statusStr, match.statusEnum, match.statusName, match.statusDisplay].join(" ").toLowerCase();
      const isApproved   = statusFields.includes("approved");
      // Detect Expired: status=7 from URL filter
      const isExpired    = match.status === 7 || statusFields.includes("expired");

      logger.info("BO deposit found", {
        username,
        remarks:    match.remarks,
        status:     match.status,
        isApproved,
        isExpired,
      });

      return {
        remarks:    match.remarks    || "-",
        status:     match.status,
        isApproved,
        isExpired,
      };
    }

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
