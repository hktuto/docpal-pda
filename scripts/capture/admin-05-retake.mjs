// Retake 05-cancel-records-awaiting-confirm.png — capture the 退回上架 cell
// (.awaiting chip + button) plus row context via a clip region. NO clicks.
import { launch, login, adminContext, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";

const auth = await login();
const browser = await launch();
const ctx = await adminContext(browser, auth);
const page = await ctx.newPage();

await page.goto("/cancel-records");
await page.waitForSelector("text=GZ2611-0175", { timeout: 15000 });
await settle(page, 1500);

const row = page.locator("tr", { hasText: "GZ2611-0175" }).first();
await row.scrollIntoViewIfNeeded();
await page.evaluate(() => {
  const wrap = document.querySelector(".table-wrap");
  if (wrap) wrap.scrollLeft = wrap.scrollWidth;
});
await settle(page, 400);
const cell = row.locator("td .awaiting").first();
await cell.screenshot({ path: `${OUT}/05-cancel-records-awaiting-confirm.png` });
console.log("shot:", `${OUT}/05-cancel-records-awaiting-confirm.png`);

await browser.close();
console.log("done");
