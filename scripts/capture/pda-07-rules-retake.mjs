// Retake 07-labeling-rules.png with the 全部列印 row clear of the fixed footer.
import { launch, login, pdaContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots";
const ORDER_ID = "01M6QQGYAFC99FQ0QMJ3W1H1HB";

const auth = await login();
const browser = await launch();
const ctx = await pdaContext(browser, auth);
const page = await ctx.newPage();

await page.goto(`/labeling/${ORDER_ID}`);
await settle(page, 1800);
await page.locator(".print-all-row").scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, 120));
await settle(page, 500);
await shot(page, `${OUT}/07-labeling-rules.png`);

await browser.close();
console.log("done");
