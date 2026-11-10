// Retake 06-receiving-issues-list.png: wide viewport so 確認/取消 buttons are visible.
import { launch, login, adminContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";

const auth = await login();
const browser = await launch();
const ctx = await adminContext(browser, auth);
await ctx.close().catch(() => {});
const wide = await browser.newContext({
  baseURL: "http://localhost:3100",
  viewport: { width: 2400, height: 1000 },
  deviceScaleFactor: 2,
});
await wide.addInitScript((t) => {
  localStorage.setItem("admin_token", t);
  localStorage.setItem("warehouse-locale", "zh-HK");
}, auth.token);
const page = await wide.newPage();

await page.goto("/issues/receiving");
await page.waitForSelector("text=收貨差異", { timeout: 15000 });
await settle(page, 2000);
await shot(page, `${OUT}/06-receiving-issues-list.png`);

await browser.close();
