// PDA 02 收貨掃描 (receiving-cn-scan) — 5 shots per docs/user-guide/pda/02-receiving-cn-scan.md.
// Task: TE-20261109-03 (scanning, AMP(205206-9) lines 2400/800/1600/8000/1600).
// NOTE: harness shim — v-model on the flag dialog's type=number input casts
// flagQty to Number, and submitFlag then crashes on flagQty.value.trim()
// (real app bug, reported). Number.prototype.trim lets the submit go through.
import { launch, login, pdaContext, shot, settle, wedge } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots";
const TASK_ID = "01M6YWWX041G0XJDZHZT7JRENR"; // TE-20261109-03

const TE_9A = "[)>06 LT3S074726091991 PN205206-9 RVW QT2400 PO200234856713 BT26433M BX51 DC26433";
const TE_9B = "[)>06 LT3S074726091992 PN205206-9 RVW QT800 PO200234856713 BT26433M BX52 DC26433";
const TE_9C = "[)>06 LT3S074726091993 PN205206-9 RVW QT1600 PO200234856713 BT26433M BX53 DC26433";

const auth = await login();
const browser = await launch();
const ctx = await pdaContext(browser, auth);
const page = await ctx.newPage();

// 1. list page — scanning orders incl. TE-20261109-03
await page.goto("/receiving-cn-scan");
await settle(page, 1500);
await shot(page, `${OUT}/02-receiving-cn-scan-list.png`);

// 2. detail page — order card + per-part scan status (initial, unscanned)
await page.locator(`a[href='/receiving-cn-scan/${TASK_ID}']`).click();
await settle(page, 1200);
await shot(page, `${OUT}/02-receiving-cn-scan-detail.png`);

// 3. scan TE-9A (2400), TE-9B (800), TE-9C (1600) — credited FIFO
for (const raw of [TE_9A, TE_9B, TE_9C]) {
  await wedge(page, raw, { settle: 1200 });
}
await settle(page, 600);

// 4. flag dialog on the part group — reason 缺貨 (default), shortfall qty 8000
await page.evaluate(() => {
  // @ts-ignore harness shim for the flagQty number-cast bug (see header)
  Number.prototype.trim = String.prototype.trim;
});
await page.getByRole("button", { name: "標記", exact: true }).first().click();
await settle(page, 500);
await page.locator(".modal input[type='number']").fill("8000");
await settle(page, 300);
await shot(page, `${OUT}/02-receiving-cn-scan-flag.png`);
// confirm the flag (creates the receiving discrepancy for Admin 06)
await page.locator(".modal").getByRole("button", { name: "標記", exact: true }).click();
await settle(page, 2000);

// 5. expand scan history (▾) — per-scan rows with 移除 buttons
await page.locator("button[aria-label='掃描記錄']").first().click();
await settle(page, 600);
await page.locator(".events").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
await settle(page, 400);
await shot(page, `${OUT}/02-receiving-cn-scan-history.png`);

// 6. finalize — remaining unresolved lines → red 其餘標記為缺貨並完成 dialog
await page.locator(".footer").getByRole("button", { name: "完成", exact: true }).click();
await settle(page, 600);
await shot(page, `${OUT}/02-receiving-cn-scan-finalize.png`);
const red = page.getByRole("button", { name: "其餘標記為缺貨並完成", exact: true });
if (await red.count()) {
  await red.click();
} else {
  await page.locator(".modal").getByRole("button", { name: "完成", exact: true }).click();
}
await settle(page, 2500);
console.log("after finalize, url:", page.url()); // → /put-away

await browser.close();
console.log("done");
