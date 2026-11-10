// Wide-viewport retakes:
//  - 05-cancel-records-awaiting-confirm.png — full page, GZ2611-0175 row with
//    退回上架 chip + 確認退回上架 button visible (NO click on the button).
//  - 06-picking-issues-resolve.png — full row (單號/客戶 visible) behind the
//    fake prompt overlay (prompt override returns null = cancel; no submit).
import { launch, login, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";

const auth = await login();
const browser = await launch();
const ctx = await browser.newContext({
  baseURL: "http://localhost:3100",
  viewport: { width: 2300, height: 1000 },
  deviceScaleFactor: 2,
});
await ctx.addInitScript((t) => {
  localStorage.setItem("admin_token", t);
  localStorage.setItem("warehouse-locale", "zh-HK");
}, auth.token);
const page = await ctx.newPage();

// 1. cancel-records awaiting shot
await page.goto("/cancel-records");
await page.waitForSelector("text=GZ2611-0175", { timeout: 15000 });
await settle(page, 1500);
await shot(page, `${OUT}/05-cancel-records-awaiting-confirm.png`);

// 2. picking issues resolve with fake prompt
await page.goto("/issues/picking");
await page.waitForSelector("text=GZ2611-0178", { timeout: 15000 });
await settle(page, 1500);
await page.evaluate(() => {
  window.prompt = (msg) => {
    const overlay = document.createElement("div");
    overlay.id = "fake-prompt";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(15,23,32,0.25);display:flex;align-items:flex-start;justify-content:center;padding-top:40vh;z-index:9999;";
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,0.35);width:24rem;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;">
        <div style="padding:0.625rem 1rem 0;font-size:0.8125rem;color:#333;font-weight:600;">localhost:3100 顯示</div>
        <div style="padding:0.625rem 1rem;font-size:0.875rem;color:#111;">${msg}</div>
        <div style="padding:0 1rem 0.75rem;"><input type="text" style="width:100%;box-sizing:border-box;padding:0.375rem 0.5rem;border:1px solid #9aa5b1;border-radius:4px;font-size:0.875rem;" /></div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem;padding:0.625rem 1rem;border-top:1px solid #e2e8f0;background:#f7f9fb;">
          <button id="fake-prompt-cancel" style="padding:0.3125rem 0.875rem;border:1px solid #c3ccd4;border-radius:6px;background:#fff;font-size:0.8125rem;">取消</button>
          <button style="padding:0.3125rem 0.875rem;border:1px solid #1b8fd4;border-radius:6px;background:#1b8fd4;color:#fff;font-size:0.8125rem;">確定</button>
        </div>
      </div>`;
    overlay.querySelector("#fake-prompt-cancel").addEventListener("click", () => overlay.remove());
    document.body.appendChild(overlay);
    return null;
  };
});
await page.locator("tr", { hasText: "GZ2611-0178" }).first().locator("button", { hasText: "解決" }).first().click();
await page.waitForSelector("#fake-prompt", { timeout: 5000 });
await settle(page, 600);
await shot(page, `${OUT}/06-picking-issues-resolve.png`);
await page.click("#fake-prompt-cancel");

await browser.close();
console.log("done");
