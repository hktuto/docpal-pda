#!/usr/bin/env node
/**
 * Capture doc screenshots for the web app list/detail pages.
 *
 * Usage (dev servers must be running: pnpm dev:backend + pnpm --filter @warehouse/web dev):
 *
 *   PDA_USER=operator PDA_PASS='DocPal2026!' node apps/web/scripts/capture-doc-screenshots.mjs
 *
 * Env:
 *   WEB_URL   web app base URL      (default http://127.0.0.1:3103)
 *   API_HOST  backend API base URL  (optional; saved as the pda-server-host
 *             pick before login, e.g. http://192.168.5.116:3002)
 *   PDA_USER / PDA_PASS  login credentials (required)
 *
 * Writes two sets:
 *   - docs/app-docs/flows/<flow>/assets/*.png + docs/app-docs/user-menu/assets/*.png
 *     (zh-HK, full-page, 390x844 @3x)
 *   - docs/mobile-screenshots/*.png (zh-CN, viewport-only 390x844 @3x)
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_URL = process.env.WEB_URL || "http://127.0.0.1:3103";
const API_HOST = process.env.API_HOST || "";
const USER = process.env.PDA_USER || "";
const PASS = process.env.PDA_PASS || "";

if (!USER || !PASS) {
  console.error("PDA_USER and PDA_PASS are required.");
  process.exit(1);
}

const VIEWPORT = { width: 390, height: 844 };
const SCALE = 3;

const SETTLE_MS = 800;

async function newSession(browser, locale) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
  });
  await context.addInitScript(
    ({ locale, apiHost }) => {
      window.localStorage.setItem("warehouse-locale", locale);
      if (apiHost) window.localStorage.setItem("pda-server-host", apiHost);
    },
    { locale, apiHost: API_HOST }
  );
  const page = await context.newPage();
  return { context, page };
}

async function login(page) {
  await page.goto(`${WEB_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="text"]').first().fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${WEB_URL}/`, { timeout: 15000 });
  await page.waitForTimeout(SETTLE_MS);
}

/** Navigate to a list page and wait for rows (or an empty state). */
async function openList(page, route) {
  await page.goto(`${WEB_URL}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".list-row, .empty", { timeout: 15000 });
  await page.waitForTimeout(SETTLE_MS);
  return (await page.locator(".list-row").count()) > 0;
}

async function shot(page, relPath, { fullPage = true } = {}) {
  const out = path.join(REPO_ROOT, relPath);
  await page.screenshot({ path: out, fullPage });
  console.log(`saved ${relPath}`);
}

/** Copy the same capture to every doc location that uses it. */
async function shotMany(page, relPaths, opts) {
  for (const rel of relPaths) await shot(page, rel, opts);
}

async function main() {
  const browser = await chromium.launch();

  // ---- zh-HK: flow + user-menu doc assets (full page) ----
  {
    const { context, page } = await newSession(browser, "zh-HK");
    await login(page);

    const lists = [
      {
        route: "/receiving",
        out: [
          "docs/app-docs/flows/receiving/assets/receiving-list.png",
          "docs/app-docs/user-menu/assets/receiving-list.png",
        ],
      },
      {
        route: "/picking",
        out: [
          "docs/app-docs/flows/picking/assets/picking-list.png",
          "docs/app-docs/user-menu/assets/picking-list.png",
        ],
      },
      {
        route: "/put-away",
        out: [
          "docs/app-docs/flows/put-away/assets/put-away-list.png",
          "docs/app-docs/user-menu/assets/put-away-list.png",
        ],
      },
      {
        route: "/verify",
        out: [
          "docs/app-docs/flows/verify/assets/verify-list.png",
          "docs/app-docs/user-menu/assets/verify-list.png",
        ],
      },
      {
        route: "/measuring",
        out: [
          "docs/app-docs/flows/measuring/assets/measuring-list.png",
          "docs/app-docs/user-menu/assets/measuring-list.png",
        ],
      },
      {
        route: "/goods-verify",
        out: [
          "docs/app-docs/flows/goods-verify/assets/goods-verify-list.png",
          "docs/app-docs/user-menu/assets/goods-verify-list.png",
        ],
      },
    ];
    for (const { route, out } of lists) {
      if (await openList(page, route)) await shotMany(page, out);
      else console.warn(`SKIP ${route}: no rows`);
    }

    // Detail pages: open the first row of each list.
    // Receiving: use the in_hand filter (3rd chip) — pending orders on the
    // synced dataset have no carton numbers, in_hand ones do, which shows
    // the carton grouping.
    if (await openList(page, "/receiving")) {
      await page.locator(".filter-chip").nth(2).click();
      await page.waitForTimeout(1500);
      await page.locator(".list-row").first().click();
      await page.waitForSelector(".list-panel .list-row", { timeout: 15000 });
      await page.waitForTimeout(SETTLE_MS);
      await shotMany(page, [
        "docs/app-docs/flows/receiving/assets/receiving-detail.png",
        "docs/app-docs/user-menu/assets/receiving-detail.png",
      ]);
    } else console.warn("SKIP receiving detail: no rows");

    if (await openList(page, "/picking")) {
      await page.locator(".list-row__main").first().click();
      await page.waitForSelector(".list-panel .list-row", { timeout: 15000 });
      await page.waitForTimeout(SETTLE_MS);
      await shotMany(page, [
        "docs/app-docs/flows/picking/assets/picking-detail.png",
        "docs/app-docs/user-menu/assets/picking-detail.png",
      ]);
    } else console.warn("SKIP picking detail: no rows");

    await context.close();
  }

  // ---- zh-CN: mobile-screenshots (viewport only) ----
  {
    const { context, page } = await newSession(browser, "zh-CN");
    await login(page);
    const opts = { fullPage: false };

    if (await openList(page, "/put-away")) await shot(page, "docs/mobile-screenshots/01-put-away-list.png", opts);
    else console.warn("SKIP 01 put-away list");
    if (await openList(page, "/picking")) await shot(page, "docs/mobile-screenshots/03-picking-list.png", opts);
    else console.warn("SKIP 03 picking list");
    if (await openList(page, "/receiving")) await shot(page, "docs/mobile-screenshots/05-receiving-list-pending.png", opts);
    else console.warn("SKIP 05 receiving list");
    if (await openList(page, "/receiving")) {
      await page.locator(".filter-chip").nth(2).click();
      await page.waitForTimeout(1500);
      await page.locator(".list-row").first().click();
      await page.waitForSelector(".list-panel .list-row", { timeout: 15000 });
      await page.waitForTimeout(SETTLE_MS);
      await shot(page, "docs/mobile-screenshots/06-receiving-detail.png", opts);
    }
    if (await openList(page, "/picking")) {
      await page.locator(".list-row__main").first().click();
      await page.waitForSelector(".list-panel .list-row", { timeout: 15000 });
      await page.waitForTimeout(SETTLE_MS);
      await shot(page, "docs/mobile-screenshots/04-picking-detail.png", opts);
    }
    if (await openList(page, "/goods-verify")) await shot(page, "docs/mobile-screenshots/08-goods-verify-task-list.png", opts);
    else console.warn("SKIP 08 goods-verify list");

    await context.close();
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
