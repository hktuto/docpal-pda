// PDA 06→09 chain part 2 (06 picking shots already captured in part 1) — one order GZ2611-0175 end to end:
// picking finish (print prompt) → issue report on GZ2611-0178 → label-printing
// queue finish (transit) → labeling → measuring → verify.
// Per docs/user-guide/capture-runbook.md sections 06/07/08/09.
import { launch, login, pdaContext, shot, settle, wedge } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots";
const ORDER = "GZ2611-0175";
const ORDER_ID = "01M6QQGYAFC99FQ0QMJ3W1H1HB";
const ISSUE_ORDER = "GZ2611-0178";
const ISSUE_ORDER_ID = "01M6QQGYB2K8GDN8427GSWHHEM";
const BOX = "BOX-S-20261109-0003";
const TE = (n) =>
  `[)>06 LT3S07472609200${n} PN2232553-1 RVW QT54000 PO200234856801 BT0 BXN DC26221`;

const auth = await login();
const browser = await launch();
const ctx = await pdaContext(browser, auth);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

// Same injected-confirm pattern as pda-03-put-away.mjs: app calls
// window.confirm synchronously; override shows a capturable modal and returns
// true (action proceeds). Dismiss the overlay via [data-confirm='ok'].
await page.addInitScript(() => {
  window.confirm = (msg) => {
    const old = document.getElementById("capture-confirm");
    old?.remove();
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
const dismissConfirm = async () => {
  const ok = page.locator("#capture-confirm [data-confirm='ok']");
  if (await ok.count()) await ok.click().catch(() => {});
};

// ---------- issue report on GZ2611-0178 ----------
await page.goto("/picking");
await settle(page, 1500);
const cb = page.locator(`.app-list-row:has(a[href='/picking/unified/${ISSUE_ORDER_ID}']) input[type='checkbox']`);
await cb.scrollIntoViewIfNeeded();
await cb.check();
await settle(page, 300);
await page.getByRole("button", { name: /匯報問題|回報問題/ }).click();
await page.waitForSelector("#issue-title", { timeout: 5000 });
await settle(page, 400);
// default reason is insufficient_stock (缺貨); fill actual qty + note
await page.locator(".modal input[type='number']").fill("0");
await page.locator(".modal textarea").fill("包裝破損，待補貨");
await settle(page, 300);
await page.locator(".modal button[type='submit']").click();
await settle(page, 1200);
console.log("issue reported for", ISSUE_ORDER);

// ---------- transit: label-printing queue finish ----------
await page.goto("/label-printing");
await settle(page, 1500);
await page.locator(`a[href='/label-printing/${ORDER_ID}']`).first().click();
await settle(page, 1200);
await page.locator("button.label-printing-footer__finish").click();
await settle(page, 1500);
await dismissConfirm();
await settle(page, 1000);
console.log("label-printing finished, url:", page.url());

// ---------- 07 labeling ----------
await page.goto("/");
await settle(page, 1200);
await page.getByText("待貼標籤", { exact: false }).first().scrollIntoViewIfNeeded();
await shot(page, `${OUT}/07-labeling-home.png`);

await page.goto("/labeling");
await settle(page, 1500);
await shot(page, `${OUT}/07-labeling-list.png`);

await page.locator(`a[href='/labeling/${ORDER_ID}']`).first().click();
await settle(page, 1500);
await shot(page, `${OUT}/07-labeling-detail-header.png`);

await page.getByText("全部列印", { exact: false }).first().scrollIntoViewIfNeeded().catch(() => {});
await settle(page, 400);
await shot(page, `${OUT}/07-labeling-rules.png`);

await page.locator("button.labeling-footer__finish").scrollIntoViewIfNeeded();
await settle(page, 300);
await page.locator("button.labeling-footer__finish").click();
await page.waitForSelector("#capture-confirm", { timeout: 5000 });
await settle(page, 400);
await shot(page, `${OUT}/07-labeling-finish.png`);
await dismissConfirm();
await settle(page, 1800);
console.log("labeling finished, url:", page.url());

// ---------- 08 measuring ----------
await page.goto("/measuring");
await settle(page, 1500);
await shot(page, `${OUT}/08-measuring-list.png`);

await page.evaluate(() => document.activeElement?.blur());
await wedge(page, BOX, { settle: 1500 });
console.log("measuring box url:", page.url());
await settle(page, 800);
await shot(page, `${OUT}/08-measuring-box.png`);

await wedge(page, TE(1), { settle: 1500 });
await shot(page, `${OUT}/08-measuring-progress.png`);
await wedge(page, TE(2), { settle: 1500 });
await wedge(page, TE(3), { settle: 1500 });
await wedge(page, TE(4), { settle: 2000 });

await page.waitForSelector(".modal-overlay #measure-title", { timeout: 8000 });
await settle(page, 500);
await page.locator(".modal select").selectOption({ label: "20 X 16 X 20" });
await page.locator(".modal input[type='number']").nth(0).fill("8.5");
await page.locator(".modal input[type='number']").nth(1).fill("9.2");
await settle(page, 400);
await shot(page, `${OUT}/08-measuring-modal.png`);
await page.getByRole("button", { name: /確認箱號/ }).click();
await settle(page, 2500);
console.log("measuring done, url:", page.url());

// ---------- 09 verify ----------
await page.goto("/verify");
await settle(page, 1500);
await shot(page, `${OUT}/verify-list.png`);

await page.goto(`/verify/${BOX}`);
await settle(page, 1500);
await shot(page, `${OUT}/verify-box-detail.png`);

const reopenBtn = page.getByRole("button", { name: /重新開啟箱號/ });
await reopenBtn.scrollIntoViewIfNeeded();
await settle(page, 400);
await shot(page, `${OUT}/verify-reopen-button.png`);

await page.evaluate(() => document.activeElement?.blur());
await wedge(page, TE(1), { settle: 1200 });
await wedge(page, TE(2), { settle: 1200 });
await wedge(page, TE(3), { settle: 1200 });
await wedge(page, TE(4), { settle: 2000 });
const completeBtn = page.getByRole("button", { name: /完成覆核/ });
await completeBtn.scrollIntoViewIfNeeded();
await settle(page, 400);
await shot(page, `${OUT}/verify-complete.png`);
await completeBtn.click();
await settle(page, 2000);
console.log("verify done, url:", page.url());

await browser.close();
console.log("done");
