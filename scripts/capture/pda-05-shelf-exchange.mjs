// PDA 05 貨架調撥 — 4 shots per docs/user-guide/pda/05-shelf-exchange.md checklist.
// Flow: home tile → /shelf-exchange → scan source shelf GZE44 → scan KOA-C
// (RK73H1ETTP 2001F x 50000) → scan target shelf GZE51 → confirm modal → 移動 (real commit).
import { launch, login, pdaContext, shot, settle, wedge } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/pda/shots";
const KOA_C = ":RK73H1ETTP2001F::54:X:1706Q306:S634:KOA+RK73H1ETTP 2001F::::";

const auth = await login();
const browser = await launch();
const ctx = await pdaContext(browser, auth);
const page = await ctx.newPage();

// 1. home with 貨架調撥 tile
await page.goto("/");
await settle(page, 1500);
await page.getByText("貨架調撥", { exact: false }).first().scrollIntoViewIfNeeded();
await shot(page, `${OUT}/05-home-tile.png`);

// 2. shelf-exchange page — scan source shelf GZE44
await page.goto("/shelf-exchange");
await settle(page, 1200);
await wedge(page, "GZE44", { settle: 1200 });
await settle(page, 3000); // let the 已選擇源貨架 toast fade
await shot(page, `${OUT}/05-source-shelf.png`);

// 3. scan item label KOA-C → matched item card
await wedge(page, KOA_C, { settle: 1500 });
await page
  .getByText("匹配的商品", { exact: false })
  .waitFor({ state: "visible", timeout: 8000 });
await settle(page, 3000); // let the 已在源貨架匹配 toast fade
await shot(page, `${OUT}/05-matched-item.png`);

// 4. scan target shelf GZE51 → confirm modal opens
await wedge(page, "GZE51", { settle: 1200 });
await page
  .getByText("確認貨架調撥", { exact: false })
  .waitFor({ state: "visible", timeout: 8000 });
await settle(page, 800);
await shot(page, `${OUT}/05-confirm-modal.png`);

// 5. real commit — click 移動
await page.getByRole("button", { name: "移動", exact: true }).click();
await page
  .getByText("已將", { exact: false })
  .waitFor({ state: "visible", timeout: 8000 })
  .catch(() => {});
await settle(page, 1500);

await browser.close();
console.log("done");
