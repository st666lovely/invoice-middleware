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
