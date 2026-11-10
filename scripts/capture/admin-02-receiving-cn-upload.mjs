// Admin 02 客戶收貨上傳 — 5 shots per docs/user-guide/admin/02-receiving-cn-upload.md checklist.
// Real upload: creates a pending CN receiving order from TE20261012-1.xls (expected).
import { launch, login, adminContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";
const XLS = "/Users/seantsang/Documents/work/docpal-pda/supporting_doc/cn_receiving/TE20261012-1.xls";

const auth = await login();
const browser = await launch();
const ctx = await adminContext(browser, auth);
const page = await ctx.newPage();

// 1. list page
await page.goto("/receiving-cn");
await settle(page, 1500);
await shot(page, `${OUT}/02-receiving-cn-list.png`);

// 2. new upload page — step 1 drop zone + file picker
await page.goto("/receiving-cn/new");
await settle(page, 1000);
await shot(page, `${OUT}/02-receiving-cn-new.png`);

// pick the Excel via setInputFiles (input is hidden, triggered by the button)
await page.locator("input[type='file']").setInputFiles(XLS);

// wait for either step 2 (verify with issues) or auto-submit to detail
let verifyVisible = false;
try {
  await page.getByText("核對資料", { exact: false }).first().waitFor({ timeout: 15000 });
  verifyVisible = await page
    .getByText("錯誤|不在零件主檔|缺少|必須", { exact: false })
    .first()
    .isVisible()
    .catch(() => false);
} catch {
  verifyVisible = false;
}
await settle(page, 1500);

if (page.url().includes("/receiving-cn/new")) {
  // step 2 verify screen
  await shot(page, `${OUT}/02-receiving-cn-verify.png`);
  // submit
  await page.getByRole("button", { name: /^確認$/ }).last().click();
  await settle(page, 2500);
} else {
  console.log("note: excel auto-submitted without verify step; capturing fallback verify shot skipped");
  // still capture whatever detail screen we landed on as placeholder evidence
  await shot(page, `${OUT}/02-receiving-cn-verify.png`);
}

// wait until we land on the created order's detail page
await page.waitForURL(/\/receiving-cn\/[^/]+$/, { timeout: 20000 }).catch(() => {});
await settle(page, 1500);
const detailUrl = page.url();
const batchNo = decodeURIComponent(detailUrl.split("/receiving-cn/")[1] || "").split(/[?#]/)[0];
console.log("created order:", batchNo || "(unknown)", detailUrl);

// 4. list page with pending (處理中) rows on top
await page.goto("/receiving-cn");
await settle(page, 1500);
await shot(page, `${OUT}/02-receiving-cn-pending.png`);

// 5. detail page of the newly created order
if (batchNo) {
  await page.goto(`/receiving-cn/${encodeURIComponent(batchNo)}`);
} else {
  await page.goto("/receiving-cn");
  await settle(page, 1200);
  await page.locator("table a").first().click();
}
await settle(page, 1800);
await shot(page, `${OUT}/02-receiving-cn-detail.png`);

await browser.close();
console.log("done. batch_no:", batchNo);
