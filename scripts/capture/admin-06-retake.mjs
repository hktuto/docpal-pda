// Retakes: 06-picking-issues-resolve.png (fake prompt lower, row visible) and
// 06-bug-report-detail.png (dialog expanded to full content height).
// See admin-06-issues.mjs header for the window.prompt rationale.
import { launch, login, adminContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";
const BUG_NOTE = "示範：掃描器間中無反應";

const auth = await login();
const browser = await launch();
const ctx = await adminContext(browser, auth);
const page = await ctx.newPage();

// 1. picking issues resolve — fake prompt positioned below the data row
await page.goto("/issues/picking");
await page.waitForSelector("text=GZ2611-0178", { timeout: 15000 });
await settle(page, 1500);
await page.evaluate(() => {
  window.prompt = (msg) => {
    const overlay = document.createElement("div");
    overlay.id = "fake-prompt";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(15,23,32,0.25);display:flex;align-items:flex-start;justify-content:center;padding-top:44vh;z-index:9999;";
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
await settle(page, 400);

// 2. bug report detail — expand dialog so every section is visible in one shot
await page.goto("/bug-reports");
await page.waitForSelector(".page-head h1", { timeout: 15000 });
await settle(page, 1500);
const detailButtons = page.locator("tr button", { hasText: "詳情" });
const n = await detailButtons.count();
let opened = false;
for (let i = 0; i < n; i++) {
  await detailButtons.nth(i).click();
  await page.waitForSelector(".overlay .dialog", { timeout: 8000 });
  await settle(page, 500);
  const text = await page.locator(".overlay .dialog").innerText();
  if (text.includes(BUG_NOTE)) {
    opened = true;
    break;
  }
  await page.locator(".overlay .dialog .dialog-close").click();
  await settle(page, 300);
}
if (!opened) throw new Error("fresh bug report row not found");
await page.locator(".overlay .dialog").evaluate((el) => {
  el.style.maxHeight = "none";
  el.style.overflowY = "visible";
});
await settle(page, 600);
await page.locator(".overlay .dialog").screenshot({ path: `${OUT}/06-bug-report-detail.png` });
console.log("shot:", `${OUT}/06-bug-report-detail.png`);
await page.locator(".overlay .dialog .dialog-close").click();

await browser.close();
console.log("done");
