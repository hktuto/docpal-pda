// Admin 05 取消發票 — 4 shots per docs/user-guide/admin chapter 05 checklist.
// Requires demo-cancel-0001 already processed by the cron (cancel_records +
// awaiting put_back_tasks). Does NOT click 確認退回上架, does NOT save a
// replacement invoice.
import { launch, login, adminContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";

const auth = await login();
const browser = await launch();
const ctx = await adminContext(browser, auth);
const page = await ctx.newPage();

await page.goto("/cancel-records");
await page.waitForSelector("text=取消發票", { timeout: 15000 });
await page.waitForSelector("text=GZ2611-0175", { timeout: 15000 });
await settle(page, 1500);

// 1. overview
await shot(page, `${OUT}/05-cancel-records-overview.png`);

// 2. expand the 結果 (outcome) SearchableSelect — second filter
await page.locator(".filters .ssel-toggle").nth(1).click();
await settle(page, 500);
await page.waitForSelector(".ssel-panel .ssel-item", { timeout: 5000 });
await shot(page, `${OUT}/05-cancel-records-filter-outcome.png`);
await page.keyboard.press("Escape");
await settle(page, 400);

// 3. replacement-invoice search suggestions for the GZ2611-0175 row
const row = page.locator("tr", { hasText: "GZ2611-0175" }).first();
const input = row.locator("input.pos-input");
await input.click();
await input.pressSequentially("GZ2611", { delay: 60 });
await page.waitForSelector(".pos-panel .pos-item", { timeout: 8000 });
await settle(page, 800);
await shot(page, `${OUT}/05-cancel-records-replacement-search.png`);
// clear the draft WITHOUT committing a save: reset the input to "" then blur —
// saveReplacement is a no-op when the value round-trips back to null.
await input.fill("");
await page.keyboard.press("Escape");
await settle(page, 400);

// 4. awaiting put-back cell: "N 項待確認" chip + 確認退回上架 button (NO click)
await row.scrollIntoViewIfNeeded();
await settle(page, 400);
await row.screenshot({ path: `${OUT}/05-cancel-records-awaiting-confirm.png` });
console.log("shot:", `${OUT}/05-cancel-records-awaiting-confirm.png`);

await browser.close();
console.log("done");
