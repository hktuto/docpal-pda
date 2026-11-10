// Admin 03 揀貨單 — 6 shots per docs/user-guide/admin/03-picking-orders.md checklist.
// Uses GZ2611-0176 (allocated). Final shot clicks 重新分配 on 0176 ONLY.
import { launch, login, adminContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";
const ORDER_ID = "01M6QQGYAMHT1EH0E1P2WR6WCQ";

const auth = await login();
const browser = await launch();
const ctx = await adminContext(browser, auth);
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());

// 1. picking orders list — overall layout
await page.goto("/picking-orders");
await page.waitForSelector("text=揀貨單", { timeout: 15000 });
await settle(page, 1500);
await shot(page, `${OUT}/03-picking-orders-list.png`);

// 2. expand 狀態 SearchableSelect, tick extra statuses (multi-select)
await page.locator(".ssel-toggle").first().click();
await settle(page, 400);
await page.locator(".ssel-panel .ssel-item", { hasText: "揀貨中" }).first().click();
await settle(page, 400);
await page.locator(".ssel-panel .ssel-item", { hasText: "揀貨完成" }).first().click();
await settle(page, 600);
await shot(page, `${OUT}/03-picking-orders-status-filter.png`);
await page.keyboard.press("Escape");
await settle(page, 500);

// navigate to GZ2611-0176 detail (id from /picking-orders?q= lookup)
await page.goto(`/picking-orders/${ORDER_ID}`);
await page.waitForSelector(".page-head h1", { timeout: 15000 });
await settle(page, 1500);

// 3. edit info area — delivery date field + 儲存 button
const saveBtn = page.locator("button.btn-primary", { hasText: "儲存" }).first();
await saveBtn.scrollIntoViewIfNeeded();
await settle(page, 600);
await shot(page, `${OUT}/03-picking-orders-edit-info.png`);

// 4. 零件可用量 modal — click the first 🔍 availability button
await page.locator("button", { hasText: "🔍" }).first().click();
await settle(page, 1200);
await shot(page, `${OUT}/03-picking-orders-availability.png`);
// close modal
await page.keyboard.press("Escape");
await page.locator(".modal-close, button", { hasText: /關閉|×/ }).first().click({ timeout: 2000 }).catch(() => {});
await settle(page, 500);

// 5. top button row (下載揀貨清單 / 列印 — do NOT click 列印)
await page.evaluate(() => window.scrollTo(0, 0));
await settle(page, 400);
const head = page.locator(".page-head");
await head.screenshot({ path: `${OUT}/03-picking-orders-download.png` });
console.log("shot:", `${OUT}/03-picking-orders-download.png`);

// 6. 重新分配 → green 分配完成 banner (0176 only; dialog auto-accepted above)
await page.locator("button.btn", { hasText: "重新分配" }).first().click();
await page.waitForSelector(".alloc-done-banner", { timeout: 30000 });
await settle(page, 600);
await page.evaluate(() => window.scrollTo(0, 0));
await shot(page, `${OUT}/03-picking-orders-reallocate-done.png`);

await browser.close();
console.log("done");
