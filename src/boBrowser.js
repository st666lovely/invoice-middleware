"use strict";

const logger = require("./logger");

let chromium;
try {
  const { chromium: extraChromium } = require("playwright-extra");
  const stealth = require("puppeteer-extra-plugin-stealth")();
  extraChromium.use(stealth);
  chromium = extraChromium;
} catch (e) {
  chromium = require("playwright").chromium;
}

const BO_LOGIN_URL = process.env.BO_LOGIN_URL || "https://bo.bo666st.com/login";
const BO_DEPOSIT_URL = process.env.BO_DEPOSIT_URL || "https://bo.bo666st.com/depositAudit";
const BO_USERNAME = process.env.BO_USERNAME;
const BO_PASSWORD = process.env.BO_PASSWORD;

async function fillFirstVisible(page, selectors, value, timeout = 45000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();

        if (await loc.count()) {
          if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
            await loc.fill(value);
            return selector;
          }
        }
      } catch {}
    }

    await page.waitForTimeout(500);
  }

  throw new Error("Không tìm thấy input visible: " + selectors.join(" | "));
}

async function clickFirstVisible(page, selectors, timeout = 45000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();

        if (await loc.count()) {
          if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
            await loc.click();
            return selector;
          }
        }
      } catch {}
    }

    await page.waitForTimeout(500);
  }

  throw new Error("Không tìm thấy button visible: " + selectors.join(" | "));
}

async function fetchDepositRemarkByUsername(username) {
  if (!BO_USERNAME || !BO_PASSWORD) {
    throw new Error("BO_USERNAME / BO_PASSWORD chưa được cấu hình");
  }

  if (!username) return null;

  let browser;
  let page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "Asia/Ho_Chi_Minh",
    });

    page = await context.newPage();

    logger.info("BO browser open login");

    await page.goto(BO_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(3000);

    logger.info("BO browser login page", {
      url: page.url(),
      title: await page.title().catch(() => ""),
    });

    if (page.url().includes("/login")) {
      const userSelector = await fillFirstVisible(
        page,
        [
          "#userid",
          '[data-testid="login-userid"]',
          'input[placeholder="User Name"]',
          'input[type="text"].formik-input',
          'input[type="text"]',
        ],
        BO_USERNAME
      );

      const passSelector = await fillFirstVisible(
        page,
        [
          "#password",
          '[data-testid="login-password"]',
          'input[placeholder="Password"]',
          'input[type="password"].formik-input',
          'input[type="password"]',
        ],
        BO_PASSWORD
      );

      logger.info("BO browser login selectors", {
        userSelector,
        passSelector,
      });

      await Promise.all([
        page.waitForLoadState("networkidle", {
          timeout: 45000,
        }).catch(() => {}),

        clickFirstVisible(page, [
          'button:has-text("Login")',
          'button[type="submit"]',
          ".nrc-button",
          "button",
        ]),
      ]);

      await page.waitForTimeout(5000);

      logger.info("BO browser after login", {
        url: page.url(),
        title: await page.title().catch(() => ""),
      });
    }

    logger.info("BO browser goto depositAudit");

    // Intercept API response để lấy remarks trực tiếp từ JSON
    let searchData = null;
    page.on("response", async (resp) => {
      try {
        // Log tất cả API calls từ boapi để biết endpoint thực tế
        if (resp.url().includes("boapi.bo666st.com")) {
          logger.info("BO API call", {
            url:    resp.url().split("?")[0],
            status: resp.status(),
          });
        }
        if (resp.url().includes("/deposits/search") && resp.status() === 200) {
          searchData = await resp.json();
        }
      } catch {}
    });

    await page.goto(BO_DEPOSIT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(5000);

    const playerInputs = page.locator('input[placeholder="Please enter text"]');

    const count = await playerInputs.count();

    if (!count) {
      throw new Error("Không tìm thấy ô nhập Player ID");
    }

    const input = playerInputs.nth(count - 1);

    await input.fill(username);

    await Promise.all([
      page.waitForResponse(
        (resp) =>
          resp.url().includes("/deposits/search") &&
          resp.status() === 200,
        { timeout: 45000 }
      ).catch(() => null),

      clickFirstVisible(page, [
        'button:has-text("Search")',
        ".form-btn .nrc-button:not(.button-gray)",
        "button.nrc-button",
      ]),
    ]);

    await page.waitForTimeout(4000);

    // ── Cách 1: Lấy từ API response (nhanh + chính xác) ─────────────────────
    logger.info("BO browser searchData debug", {
      username,
      isNull:  searchData === null,
      type:    typeof searchData,
      isArray: Array.isArray(searchData),
      keys:    searchData ? Object.keys(searchData).slice(0, 10) : [],
    });

    const list = !searchData                          ? []
               : Array.isArray(searchData)            ? searchData
               : Array.isArray(searchData?.data)      ? searchData.data
               : Array.isArray(searchData?.list)      ? searchData.list
               : Array.isArray(searchData?.items)     ? searchData.items
               : Array.isArray(searchData?.deposits)  ? searchData.deposits
               : Array.isArray(searchData?.content)   ? searchData.content
               : Array.isArray(searchData?.result)    ? searchData.result
               : [];

    logger.info("BO browser list parsed", {
      username,
      count:        list.length,
      firstStatus:  list[0]?.status,
      firstRemarks: list[0]?.remarks,
    });

    if (list.length > 0 && list[0]?.remarks) {
      const remark = list[0].remarks;
      logger.info("BO browser remark result (API)", { username, remark });
      return remark;
    }

    // ── Cách 2: Fallback scrape DOM nếu API không trả được ───────────────────
    const remark = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

      const headerSpan = [...document.querySelectorAll("span")]
        .find(el => norm(el.innerText) === "Deposit Remark");

      if (!headerSpan) return null;

      const headerBox = headerSpan.getBoundingClientRect();
      const headerCenterX = headerBox.left + headerBox.width / 2;

      const cells = [
        ...document.querySelectorAll(
          ".nrc-table-column, [class*='table-column'], [class*='column']"
        ),
      ];

      let best = null;
      let bestScore = Infinity;

      for (const cell of cells) {
        const text = norm(cell.innerText);

        if (!text) continue;
        if (/Deposit Remark/i.test(text)) continue;
        if (/No Data/i.test(text)) continue;

        const box = cell.getBoundingClientRect();

        if (box.top <= headerBox.bottom) continue;

        const centerX = box.left + box.width / 2;
        const diff = Math.abs(centerX - headerCenterX);

        if (diff < bestScore) {
          bestScore = diff;
          best = text;
        }
      }

      return best;
    });

    logger.info("BO browser remark result (DOM)", { username, remark });
    return remark || null;

  } catch (err) {
    let debug = {};

    try {
      debug = {
        url: page ? page.url() : null,
        title: page ? await page.title().catch(() => "") : "",
        html: page ? (await page.content()).slice(0, 2000) : "",
      };
    } catch {}

    logger.error("BO browser fetchDepositRemark failed", {
      username,
      error: err.message,
      ...debug,
    });

    return null;

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  fetchDepositRemarkByUsername,
};
