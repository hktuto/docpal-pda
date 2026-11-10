// Admin 06 問題與警示 — 5 shots.
// NOTE on 06-picking-issues-resolve.png: the resolve button uses native
// window.prompt, which headless Chrome neither renders nor allows screenshots
// of (probe: page.screenshot times out while a JS dialog is open). This script
// overrides window.prompt on that page with a DOM overlay styled like the
// Chrome macOS prompt; the override returns null (= 取消), so nothing is
// submitted. Everything else is the real UI.
import { launch, login, adminContext, pdaContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";
const PHOTO = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots/08-measuring-box.png";
const BUG_NOTE = "示範：掃描器間中無反應";

const auth = await login();
const browser = await launch();
const ctx = await adminContext(browser, auth);
const page = await ctx.newPage();

// 1. nav sidebar with the 問題 section expanded
await page.goto("/");
await settle(page, 1500);
const issuesHead = page.locator(".nav-section-head", { hasText: "問題" }).first();
// expand only if collapsed (no open caret)
const caretOpen = await issuesHead.locator(".caret.open").count();
if (caretOpen === 0) await issuesHead.click();
await settle(page, 800);
await page.locator("aside.sidebar").screenshot({ path: `${OUT}/06-nav-issues-section.png` });
console.log("shot:", `${OUT}/06-nav-issues-section.png`);

// 2. receiving mismatch list
await page.goto("/issues/receiving");
await page.waitForSelector(".page-head h1", { timeout: 15000 });
await settle(page, 1500);
await shot(page, `${OUT}/06-receiving-issues-list.png`);

// 3. picking issue resolve prompt (fake-prompt override — see header note)
await page.goto("/issues/picking");
await page.waitForSelector("text=GZ2611-0178", { timeout: 15000 });
await settle(page, 1500);
await page.evaluate(() => {
  window.prompt = (msg) => {
    const overlay = document.createElement("div");
    overlay.id = "fake-prompt";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(15,23,32,0.35);display:flex;align-items:flex-start;justify-content:center;padding-top:18vh;z-index:9999;";
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,0.35);width:24rem;padding:0;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;">
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
    return null; // = user pressed 取消 — resolve() aborts, nothing is submitted
  };
});
const issueRow = page.locator("tr", { hasText: "GZ2611-0178" }).first();
await issueRow.locator("button", { hasText: "解決" }).first().click();
await page.waitForSelector("#fake-prompt", { timeout: 5000 });
await settle(page, 600);
await shot(page, `${OUT}/06-picking-issues-resolve.png`);
await page.click("#fake-prompt-cancel");
await settle(page, 400);

// 4. outdated-warnings resolve dialog (real dialog; type a note, do NOT submit)
await page.goto("/outdated-warnings");
await page.waitForSelector("text=GZ2611-0177", { timeout: 15000 });
await settle(page, 1500);
const warnRow = page.locator("tr", { hasText: "GZ2611-0177" }).first();
await warnRow.locator("button", { hasText: "處理訂單" }).click();
await page.waitForSelector(".overlay .dialog", { timeout: 5000 });
await page.fill("#ow-note", "示範：聯絡客戶確認中");
await settle(page, 600);
await shot(page, `${OUT}/06-outdated-warnings-dialog.png`);
await page.locator(".overlay .dialog .dialog-actions button", { hasText: "取消" }).click();
await settle(page, 400);

// 5. submit a bug report WITH a photo from the PDA app, then open it in admin
const pda = await pdaContext(browser, auth);
const pdaPage = await pda.newPage();
await pdaPage.goto("/");
await settle(pdaPage, 1500);
await pdaPage.locator(".app-header__bug").click();
await pdaPage.waitForSelector(".modal-overlay", { timeout: 8000 });
await pdaPage.locator(".modal-overlay textarea").fill(BUG_NOTE);
await pdaPage.setInputFiles(".modal-overlay input[type=file]", PHOTO);
await pdaPage.waitForSelector(".photo-preview", { timeout: 8000 });
await settle(pdaPage, 600);
await pdaPage.locator(".modal-overlay button[type=submit]").click();
await pdaPage.waitForSelector(".modal-overlay", { state: "detached", timeout: 10000 });
await settle(pdaPage, 1000);
await pda.close();

await page.goto("/bug-reports");
await page.waitForSelector(".page-head h1", { timeout: 15000 });
await settle(page, 1500);
// open the row whose detail dialog contains our note (iterate if needed)
const detailButtons = page.locator("tr button", { hasText: /詳情|详情|Details/ });
const n = await detailButtons.count();
let opened = false;
for (let i = 0; i < n; i++) {
  await detailButtons.nth(i).click();
  await page.waitForSelector(".overlay .dialog", { timeout: 8000 });
  await settle(page, 600);
  const text = await page.locator(".overlay .dialog").innerText();
  if (text.includes(BUG_NOTE)) {
    opened = true;
    break;
  }
  await page.locator(".overlay .dialog .dialog-close").click();
  await settle(page, 300);
}
if (!opened) throw new Error("could not find the freshly submitted bug report row");
// scroll dialog to show photo + bottom status/UAT fields
await page.locator(".overlay .dialog").evaluate((el) => (el.scrollTop = el.scrollHeight));
await settle(page, 600);
await shot(page, `${OUT}/06-bug-report-detail.png`);
await page.locator(".overlay .dialog .dialog-close").click();
await settle(page, 300);

await browser.close();
console.log("done");
