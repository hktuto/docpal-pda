// PDA 01 手動收貨 — 4 shots per docs/user-guide/pda/01-manual-receiving.md checklist.
import { launch, login, pdaContext, shot, settle, wedge } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots";

// Scan strings from the runbook (KOA supplier labels)
const KOA_A = ":RK73H1JRTTD3400F::253:X:1714Q713:S648:KOA+RK73H1JRTTD 3400F::::";
const KOA_B = ":RK73H2BTTD1624F::53:X:1708H339:604:KOA+RK73H2BTTD 1624F::::";
const KOA_C = ":RK73H1ETTP2001F::54:X:1706Q306:S634:KOA+RK73H1ETTP 2001F::::";

const auth = await login();
const browser = await launch();
const ctx = await pdaContext(browser, auth);
const page = await ctx.newPage();

// 1. empty task page
await page.goto("/manual-receiving");
await settle(page, 1200);
await shot(page, `${OUT}/01-manual-receiving-empty.png`);

// 2. add two order numbers → two order cards
const orderInput = page.locator("#mr-order-no");
await orderInput.click();
await orderInput.pressSequentially("32926111001", { delay: 15 });
await page.locator(".add-order__row .btn").click();
await settle(page, 300);
await orderInput.click();
await orderInput.pressSequentially("32926111002", { delay: 15 });
await page.locator(".add-order__row .btn").click();
await settle(page, 400);
await shot(page, `${OUT}/01-manual-receiving-orders.png`);

// 3. enter scan view for order 1, scan KOA-A + KOA-B
await page.locator(".order-card").first().getByRole("button", { name: "掃描" }).click();
await settle(page, 600);
await page.locator("body").click({ position: { x: 10, y: 400 } }); // move focus off buttons
await wedge(page, KOA_A, { settle: 1200 });
await wedge(page, KOA_B, { settle: 1200 });
await shot(page, `${OUT}/01-manual-receiving-scan.png`);

// finish scan for order 1 → back to task view
await page.getByRole("button", { name: "完成掃描" }).click();
await settle(page, 500);

// order 2 also needs ≥1 item or 完成 stays disabled — scan one KOA-C into it
await page.locator(".order-card").nth(1).getByRole("button", { name: "掃描" }).click();
await settle(page, 600);
await page.locator("body").click({ position: { x: 10, y: 400 } });
await wedge(page, KOA_C, { settle: 1200 });
await page.getByRole("button", { name: "完成掃描" }).click();
await settle(page, 500);

// 4. click 完成 → confirm dialog (shot), then really confirm
await page.locator(".footer .btn:not(.btn--ghost)").click();
await settle(page, 500);
await shot(page, `${OUT}/01-manual-receiving-confirm.png`);
await page.locator(".modal .btn:not(.btn--ghost)").click();
await settle(page, 1500);
console.log("final url:", page.url());

await browser.close();
console.log("done");
