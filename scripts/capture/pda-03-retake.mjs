// One-off retake for 03-shelf.png on KOA-20261110-01 (skip-scan confirm modal).
// OK stays inert until window.__armConfirm = true — guarantees the modal is
// still open for the screenshot. Cancel afterwards: no server mutation.
import { launch, login, pdaContext, shot, settle, wedge } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots";
const TASK_ID = "01a1c5b3-bf36-7969-8033-0368bdaf08ee"; // KOA-20261110-01
const SHELF = "GZE66";

const auth = await login();
const browser = await launch();
const ctx = await pdaContext(browser, auth);
const page = await ctx.newPage();

// The app calls window.confirm SYNCHRONOUSLY (native blocking confirm) — an
// async replacement returns a truthy Promise and the action proceeds anyway.
// So: render the modal purely for the screenshot and return false (cancel).
// Nothing is staged or committed on this task.
await page.addInitScript(() => {
  window.confirm = (msg) => {
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
    return false;
  };
});

await page.goto(`/put-away/cn?task=${TASK_ID}`);
await settle(page, 1500);

// scan the shelf once first → 貨架 banner; then tick the group and re-scan
// the shelf → skip-scan confirm modal on top of the banner
await wedge(page, SHELF, { settle: 900 });
const card = page.locator(".card", { hasText: "RK73H1ETTP" });
await card.locator("label.select-box input[type='checkbox']").check();
await settle(page, 300);
await page.evaluate(() => {
  document.activeElement?.blur();
  window.scrollTo(0, 0); // shelf banner visible behind the modal
});
await settle(page, 300);
await wedge(page, SHELF, { settle: 600 });
await page.waitForSelector("#capture-confirm", { timeout: 5000 });
await settle(page, 400);
await shot(page, `${OUT}/03-shelf.png`);

// dismiss the visual modal — confirm already returned false, nothing staged
await page.locator("#capture-confirm [data-confirm='cancel']").click();
await settle(page, 500);
console.log("modals after cancel:", await page.locator("#capture-confirm").count());

await browser.close();
console.log("done (no commit)");
