// Admin 08 庫存查詢 — 4 shots per docs/user-guide/admin/08-stock-search.md checklist.
import { launch, login, adminContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";
const auth = await login();
const browser = await launch();
const ctx = await adminContext(browser, auth);
const page = await ctx.newPage();

// 1. overview — menu highlights 庫存查詢 + summary cards
await page.goto("/stock-search");
await page.waitForSelector(".summary-card", { timeout: 15000 });
await settle(page, 800);
await shot(page, `${OUT}/08-stock-search-overview.png`);

// 2. filters close-up — element shot of the filter bar
const filters = page.locator(".filters");
await filters.scrollIntoViewIfNeeded();
await settle(page, 300);
await filters.screenshot({ path: `${OUT}/08-stock-search-filters.png` });
console.log("shot:", `${OUT}/08-stock-search-filters.png`);

// 3. search RK73H1ETTP → lots table with rows + pager (full page to include pager)
await page.locator(".filters input").first().fill("RK73H1ETTP");
await page.getByRole("button", { name: "搜尋" }).click();
await page.waitForSelector(".part-cell", { timeout: 15000 });
await settle(page, 800);
await page.screenshot({ path: `${OUT}/08-stock-search-results.png`, fullPage: true });
console.log("shot:", `${OUT}/08-stock-search-results.png`);

// 4. lot history — the 1000F lots on page 1 have no movements; narrow the
// search to the 2001F lots (PDA flows created ADJUST/MOVE records for them).
await page.locator(".filters input").first().fill("RK73H1ETTP 2001F");
await page.getByRole("button", { name: "搜尋" }).click();
await settle(page, 1500);
await page.waitForSelector(".part-cell", { timeout: 15000 });
async function findLot(minTables) {
  const icons = page.locator(".part-cell .btn-icon");
  const n = await icons.count();
  for (let i = 0; i < n; i++) {
    await icons.nth(i).click();
    await settle(page, 1200);
    const tables = await page.locator(".lot-history-dialog .lot-table").count();
    if (tables >= minTables) return true;
    await page.locator(".lot-history-dialog .dialog-close").click();
    await settle(page, 400);
  }
  return false;
}
if (!(await findLot(2)) && !(await findLot(1))) {
  throw new Error("no lot with history found on this page");
}
await settle(page, 800);
await shot(page, `${OUT}/08-stock-search-lot-history.png`);

await browser.close();
console.log("done");
