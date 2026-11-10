// PDA 10 查貨 — 5 shots per docs/user-guide/pda/10-goods-verify.md checklist.
import { launch, login, pdaContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots";
const auth = await login();
const browser = await launch();
const ctx = await pdaContext(browser, auth);
const page = await ctx.newPage();

// 1. home with 查貨 tile (scroll it into view first)
await page.goto("/");
await settle(page, 1200);
await page.getByText("查貨", { exact: false }).first().scrollIntoViewIfNeeded();
await shot(page, `${OUT}/10-home-tile.png`);

// 2. goods-verify list — default date is today; switch to 2026-11-04 (has pending tasks)
await page.goto("/goods-verify");
await settle(page, 1000);
await page.locator("input[type='date']").fill("2026-11-04");
await page.locator("h1, header").first().click().catch(() => {}); // blur the date input
await settle(page, 1000);
await shot(page, `${OUT}/10-list.png`);

// 3. open first task detail
await page.locator("a[href^='/goods-verify/']").first().click();
await settle(page, 1000);
await shot(page, `${OUT}/10-detail.png`);

// 4. confirm button area (scroll to bottom)
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await settle(page, 400);
await shot(page, `${OUT}/10-confirm-button.png`);

// click 確定 and capture confirmed state
await page.getByRole("button", { name: /確定|確認/ }).last().click();
await settle(page, 800);
try {
  await page.getByRole("button", { name: /確定|確認/ }).last().click({ timeout: 1500 });
} catch {}
await settle(page, 1000);
await shot(page, `${OUT}/10-confirmed.png`);

await browser.close();
console.log("done");
