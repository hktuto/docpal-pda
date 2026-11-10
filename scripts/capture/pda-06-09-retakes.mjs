// Retakes for the 06-09 chain:
//  - 07-labeling-rules.png with the 全部列印 row visible
//  - 07-labeling-finish.png with the confirm dialog over the detail page
//    (confirm override returns FALSE first so nothing happens, screenshot,
//    then re-arm to true and actually finish — restores labeling_pending=false)
//  - verify-complete.png without the toast covering the buttons
//    (verify task re-staged to pending; rescanned qty already full, so
//    完成覆核 shows immediately; click completes it again — idempotent)
//  - picking-detail-top.png with the page ⋯ menu open (order info rows)
import { launch, login, pdaContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots";
const ORDER_ID = "01M6QQGYAFC99FQ0QMJ3W1H1HB";
const BOX = "BOX-S-20261109-0003";

const auth = await login();
const browser = await launch();
const ctx = await pdaContext(browser, auth);
const page = await ctx.newPage();

await page.addInitScript(() => {
  window.__confirmResult = false;
  window.confirm = (msg) => {
    document.getElementById("capture-confirm")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "capture-confirm";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999;font-family:inherit";
    const card = document.createElement("div");
    card.style.cssText =
      "background:#fff;border-radius:12px;padding:1.25rem;width:86%;max-width:330px;box-shadow:0 12px 32px rgba(0,0,0,.25)";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 1.1rem;font-size:1rem;line-height:1.5;color:#1f2933";
    p.textContent = msg;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:.6rem;justify-content:flex-end";
    const cancel = document.createElement("button");
    cancel.dataset.confirm = "cancel";
    cancel.textContent = "取消";
    cancel.style.cssText =
      "padding:.55rem 1.1rem;border:1px solid #cbd2d9;border-radius:8px;background:#fff;color:#1f2933;font-size:.95rem";
    const ok = document.createElement("button");
    ok.dataset.confirm = "ok";
    ok.textContent = "確認";
    ok.style.cssText =
      "padding:.55rem 1.1rem;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:.95rem;font-weight:600";
    cancel.onclick = () => overlay.remove();
    ok.onclick = () => overlay.remove();
    row.append(cancel, ok);
    card.append(p, row);
    overlay.append(card);
    document.body.appendChild(overlay);
    return window.__confirmResult;
  };
});

// --- 06 retake: detail top with page menu open (order info rows) ---
await page.goto(`/picking/unified/${ORDER_ID}`);
await settle(page, 1800);
const menuToggle = page.locator(".app-header__menu-toggle").first();
await menuToggle.click();
await settle(page, 600);
const menuBody = page.locator(".app-header__menu-body");
if ((await menuBody.count()) && (await menuBody.first().innerText()).trim().length > 0) {
  await shot(page, `${OUT}/picking-detail-top.png`);
} else {
  console.log("page menu empty — keeping original picking-detail-top.png");
}
await page.keyboard.press("Escape").catch(() => {});

// --- 07 retakes ---
await page.goto(`/labeling/${ORDER_ID}`);
await settle(page, 1800);
// rules shot: scroll 全部列印 row into view
await page.locator(".print-all-row").scrollIntoViewIfNeeded();
await settle(page, 500);
await shot(page, `${OUT}/07-labeling-rules.png`);

// finish confirm dialog shot — first click does nothing (confirm → false)
await page.locator("button.labeling-footer__finish").scrollIntoViewIfNeeded();
await settle(page, 300);
await page.locator("button.labeling-footer__finish").click();
await page.waitForSelector("#capture-confirm", { timeout: 5000 });
await settle(page, 400);
await shot(page, `${OUT}/07-labeling-finish.png`);
// actually finish: re-arm confirm → true, dismiss overlay, click again
await page.evaluate(() => { window.__confirmResult = true; });
await page.locator("#capture-confirm [data-confirm='ok']").click();
await page.locator("button.labeling-footer__finish").click();
await settle(page, 1800);
console.log("labeling re-finished, url:", page.url());

// --- 09 retake: verify-complete without toast ---
await page.goto(`/verify/${BOX}`);
await settle(page, 2000);
const completeBtn = page.getByRole("button", { name: /完成覆核/ });
await completeBtn.scrollIntoViewIfNeeded();
await settle(page, 600);
await shot(page, `${OUT}/verify-complete.png`);
await completeBtn.click();
await settle(page, 2000);
console.log("verify re-completed, url:", page.url());

await browser.close();
console.log("done");
