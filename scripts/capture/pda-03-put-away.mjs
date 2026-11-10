// PDA 03 上架 — 5 shots per docs/user-guide/pda/03-put-away.md checklist.
// Task: TE-20261106-09 CN put-away task (item AMP(205206-9) × 8000 remaining).
// Flow: list → detail → scan shelf GZE66 → scan TE-9D (800) → skip-scan the
// remaining 7200 onto GZE66 (confirm dialog) → batch commit (confirm dialog)
// → task completes.
// Requires a PENDING TE-20261106-09 task — it was completed by the 2026-11-10
// capture run, so this script is a record, not re-runnable as-is.
// The final 03-pending.png / 03-shelf.png came from pda-03-retake.mjs on the
// KOA-20261110-01 task (staged locally, never committed) for cleaner framing.
import { launch, login, pdaContext, shot, settle, wedge } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots";
const TASK_ID = "01a1afba-c740-708c-bfee-6a5069bd68d4"; // TE-20261106-09

const TE_9D = "[)>06 LT3S074726091994 PN205206-9 RVW QT800 PO200234856713 BT26433M BX54 DC26433";
const SHELF = "GZE66";

const auth = await login();
const browser = await launch();
const ctx = await pdaContext(browser, auth);
const page = await ctx.newPage();

// Replace window.confirm with an in-page modal so the confirm prompts are
// captured in screenshots (native dialogs don't render in page screenshots).
// NOTE: the app calls window.confirm SYNCHRONOUSLY (native blocking confirm),
// so the override must return a boolean — an async/Promise override would be
// truthy and the guarded action would proceed regardless. Returning true
// keeps the flow moving; the modal stays up for the screenshot and is
// dismissed by clicking 確認 afterwards.
// Buttons carry data-confirm="ok|cancel".
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
    return true;
  };
});

// 1. put-away list — pending tasks incl. TE-20261106-09
await page.goto("/put-away");
await settle(page, 1500);
await shot(page, `${OUT}/03-list.png`);

// 2. detail — item cards with 總數/已掃描/已上架 progress
await page.locator(`a[href*='task=${TASK_ID}']`).click();
await settle(page, 1500);
await shot(page, `${OUT}/03-detail.png`);

// 3. CN flow is shelf-first: scan shelf GZE66 (banner), then TE-9D (800 pcs)
await wedge(page, SHELF, { settle: 900 });
await wedge(page, TE_9D, { settle: 1500 });
// the scanned card auto-expands and scrolls into view
await shot(page, `${OUT}/03-pending.png`);

// 4. skip-scan: tick the group's checkbox, then re-scan the shelf →
//    "直接將 1 個物料共 7200 件上架到貨架 GZE66？" confirm modal
await page.locator("label.select-box input[type='checkbox']").first().check();
await settle(page, 300);
// the wedge listener ignores keys while a form element has focus — blur the checkbox
await page.evaluate(() => document.activeElement?.blur());
await wedge(page, SHELF, { settle: 400 });
await page.waitForSelector("#capture-confirm", { timeout: 5000 });
await settle(page, 300);
await shot(page, `${OUT}/03-shelf.png`);
await page.locator("#capture-confirm [data-confirm='ok']").click();
await settle(page, 1000);

// 5. batch commit — "上架 8000 件" → "立即上架已掃描的 8000 件？" → confirm
await page.locator(".cn-commit .btn--primary").click();
await page.waitForSelector("#capture-confirm", { timeout: 5000 });
await settle(page, 300);
await page.locator("#capture-confirm [data-confirm='ok']").click();
await settle(page, 2500);
await shot(page, `${OUT}/03-done.png`);

console.log("final url:", page.url());
await browser.close();
console.log("done");
