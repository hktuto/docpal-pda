// Admin 04 新增 VMI — 4 shots per docs/user-guide/admin/04-vmi-upload.md checklist.
import { launch, login, adminContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";
const FILE = "/Users/seantsang/Documents/work/docpal-pda/supporting_doc/vmi/VMI_Template_20261105.xlsx";

const auth = await login();
const browser = await launch();
const ctx = await adminContext(browser, auth);
const page = await ctx.newPage();

// 1. picking-orders list — 新增 VMI button top-right
await page.goto("/picking-orders");
await settle(page, 2000);
await shot(page, `${OUT}/04-picking-orders-list.png`);

// 2. open the New VMI page and pick the Excel file — file name next to the button
await page.locator("a[href='/picking-orders/vmi']").click();
await settle(page, 1000);
await page.locator("input[type='file']").setInputFiles(FILE);
await page.waitForSelector(".items-row", { timeout: 20000 });
await settle(page, 1500);
await shot(page, `${OUT}/04-vmi-pick-file.png`);

// 3. preview block (full page: apply-to-all dropdown + all order rows)
await page.locator(".apply-all").scrollIntoViewIfNeeded();
await settle(page, 400);
await page.screenshot({ path: `${OUT}/04-vmi-preview.png`, fullPage: true });
console.log("shot: 04-vmi-preview.png");

// 4. HUAWEI sub-inventory only exists at orgs 9/140, both outside this
//    instance's allowedOrgIds — resolve all rows via 套用到所有訂單 with an
//    in-scope, allowed Huawei sub-inventory: org 7 · SZHW-NOR.
await page.locator(".apply-all .ssel-toggle").click();
await settle(page, 400);
await page.locator(".ssel-panel .ssel-item", { hasText: "7 · SZHW-NOR" }).first().click();
await settle(page, 800);

// 5. confirm creation (real upload)
const createdNos = await page.locator(".items-row > span:first-child").allTextContents();
console.log("creating orders:", createdNos.join(", "));
await page.locator("button.btn-primary").click();
await page.waitForURL("**/picking-orders", { timeout: 30000 });
await settle(page, 1500);

// 6. filter type = vmi and capture the new orders
await page.locator(".filter-type .ssel-toggle").click();
await settle(page, 400);
await page.locator(".ssel-panel .ssel-item", { hasText: "vmi" }).first().click();
await settle(page, 1500);
await page.keyboard.press("Escape"); // close the dropdown panel
await page.locator("h1").click().catch(() => {});
await page.waitForSelector(".items-row, tbody tr, [class*='row']", { timeout: 10000 }).catch(() => {});
await settle(page, 800);
await shot(page, `${OUT}/04-vmi-created-list.png`);

await browser.close();
console.log("done — created:", createdNos.join(", "));
