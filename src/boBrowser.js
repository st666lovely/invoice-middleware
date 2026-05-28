"use strict";

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

// ── Session cache + MUTEX ─────────────────────────────────────────────────────
let _session      = null;
let _loginPromise = null;   // <-- MUTEX: chỉ 1 login chạy tại 1 thời điểm

async function getSession() {
  if (_session && Date.now() < _session.expiry) return _session;

  // Nếu đang có login đang chạy, chờ kết quả đó thay vì tạo login mới
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
    await page.goto(BO_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_000);

    // Tìm ô username
    const userSel = await Promise.race([
      page.waitForSelector("#userid",                        { state: "visible", timeout: 30_000 }),
      page.waitForSelector('[data-testid="login-userid"]',   { state: "visible", timeout: 30_000 }),
      page.waitForSelector('input[placeholder="User Name"]', { state: "visible", timeout: 30_000 }),
    ]).catch(() => null);

    if (!userSel) throw new Error("Không tìm thấy ô login");

    await userSel.fill(BO_USERNAME);
    await page.fill("#password", BO_PASSWORD).catch(() =>
      page.fill('[data-testid="login-password"]', BO_PASSWORD)
    );
    await page.waitForTimeout(500);

    // Click login và chờ navigation — KHÔNG dùng waitForURL vì dễ timeout trên SPA
    await page.click('button:has-text("Login")');

    // Chờ URL đổi HOẶC element dashboard xuất hiện — linh hoạt hơn
    await Promise.race([
      page.waitForURL(url => !url.toString().includes("/login"), {
        timeout:   60_000,
        waitUntil: "commit",   // "commit" nhanh hơn "load", đủ để biết đã navigate
      }),
      page.waitForSelector('[class*="dashboard"], [class*="main-content"], nav.sidebar, .layout-wrapper', {
        state:   "visible",
        timeout: 60_000,
      }),
    ]);

    // Kiểm tra không bị redirect về login (sai mật khẩu)
    const currentUrl = page.url();
    if (currentUrl.includes("/login")) {
      const errorMsg = await page.$eval(
        '[class*="error"], [class*="alert"], .login-error',
        el => el.textContent.trim()
      ).catch(() => "unknown error");
      throw new Error(`Login thất bại, vẫn ở trang login: ${errorMsg}`);
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
    // Chỉ reset session nếu là lỗi thực sự (không phải timeout mạng tạm thời)
    // Timeout thỉnh thoảng xảy ra trên Render — không nên reset ngay để tránh login storm
    const isAuthFailure = err.message?.includes("Login thất bại");
    if (isAuthFailure) {
      logger.error("BO login auth failure — sai credentials hoặc bị khóa", { error: err.message });
      _session = null;
    } else {
      logger.warn("BO login timeout/network error — giữ session cũ nếu còn", { error: err.message });
      // Nếu session cũ vẫn còn hạn (race condition), giữ nguyên
      // Nếu không có session cũ, _session vẫn null nhưng _loginPromise đã clear
    }
    throw err;

  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
