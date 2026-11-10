// PDA 04 臨時上架 — 5 shots per docs/user-guide/pda/04-ad-hoc-put-away.md checklist.
import { launch, login, pdaContext, shot, settle, wedge } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots";

// 掃碼字串（capture-runbook.md 掃碼字串總表）
const KOA_C = ":RK73H1ETTP2001F::54:X:1706Q306:S634:KOA+RK73H1ETTP 2001F::::";
const KOA_C2 = ":RK73H1ETTP2001F::54:X:1706Q306:S635:KOA+RK73H1ETTP 2001F::::";
const SHELF = "GZE58";

const auth = await login();
const browser = await launch();
const ctx = await pdaContext(browser, auth);
const page = await ctx.newPage();

// 1. home with 臨時上架 tile
await page.goto("/");
await settle(page, 1200);
await page.getByText("臨時上架", { exact: false }).first().scrollIntoViewIfNeeded();
await shot(page, `${OUT}/04-home-tile.png`);

// 2. ad-hoc put-away page: pick brand KOA + first location
await page.goto("/ad-hoc-put-away");
await settle(page, 1500);

// brand dropdown
await page.locator("#brand-select").click();
await settle(page, 300);
await page.locator("#brand-select + * , .ssel", { has: page.locator(".ssel-panel") }).first();
await page.locator(".ssel-panel .ssel-item", { hasText: "KOA" }).first().click();
await settle(page, 400);

// location dropdown — first option in the list
await page.locator("#location-select").click();
await settle(page, 300);
await page.locator(".ssel-panel label.ssel-item").first().click();
await settle(page, 400);
await shot(page, `${OUT}/04-brand-location.png`);

// 3. scan shelf GZE58 → blue shelf banner
await wedge(page, SHELF, { settle: 800 });
await shot(page, `${OUT}/04-shelf-banner.png`);

// 4. scan two KOA items → item list
await wedge(page, KOA_C, { settle: 1200 });
await wedge(page, KOA_C2, { settle: 1200 });
// scroll a little so both item cards are fully visible above the scan FAB
await page.evaluate(() => window.scrollTo(0, 320));
await settle(page, 400);
await shot(page, `${OUT}/04-item-list.png`);

// 5. confirm button (scroll to bottom)
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await settle(page, 400);
await shot(page, `${OUT}/04-confirm-button.png`);

// really commit — later chapters/state depend on it (skip on retakes)
if (process.env.SKIP_COMMIT !== "1") {
  await page.locator(".btn--primary.btn--large").click();
  await settle(page, 1500);
  const remaining = await page.locator(".item-card").count();
  console.log("items after commit:", remaining);
}

await browser.close();
console.log("done");
