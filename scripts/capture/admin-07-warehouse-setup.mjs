// Admin 07 倉庫設定 — 5 shots per docs/user-guide/admin/07-warehouse-setup.md checklist.
import { launch, login, adminContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";
const API = "http://127.0.0.1:3002";
const auth = await login();
const browser = await launch();
const ctx = await adminContext(browser, auth);
const page = await ctx.newPage();

const apiGet = async (p) => {
  const r = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${auth.token}` } });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
};

const shelves = await apiGet("/admin/shelves");
const existingZone = shelves.find((s) => s.zone)?.zone ?? "";
console.log("zone sample:", existingZone, "shelves:", shelves.length);

const subInvs = await apiGet("/admin/sub-inventories");
const si = subInvs[0] ?? {};
console.log("sub-inventory sample:", si.orgId, si.secondaryInventoryName);

// 1. shelves list (table + search + zone filter)
await page.goto("/shelves");
await settle(page, 1500);
await shot(page, `${OUT}/07-shelves-list.png`);

// 2. new-shelf dialog, filled with demo data — screenshot then close WITHOUT saving
await page.getByRole("button", { name: "新增", exact: true }).click();
await settle(page, 600);
await page.locator("#ff-code").fill("DEMO01");
await page.locator("#ff-displayName").fill("DEMO-01");
await page.locator("#ff-zone").fill(existingZone);
await settle(page, 300);
await shot(page, `${OUT}/07-shelf-new-dialog.png`);
await page.locator(".dialog .dialog-close").click();
await settle(page, 500);

// 3. shelf print-label dialog (printer / size / copies) — do NOT print
await page.locator("table tbody tr").first().getByRole("button", { name: "列印", exact: true }).click();
await settle(page, 800);
await shot(page, `${OUT}/07-shelf-print-dialog.png`);
await page.locator(".dialog .dialog-close").click();
await settle(page, 500);

// 4. shelf boxes: new dialog, qty 10, createAndPrint UNCHECKED — really create (harmless)
await page.goto("/shelf-boxes");
await settle(page, 1000);
await page.getByRole("button", { name: "新增", exact: true }).click();
await settle(page, 600);
if (si.orgId != null) await page.locator("#nb-org").fill(String(si.orgId));
if (si.secondaryInventoryName) await page.locator("#nb-sub").fill(si.secondaryInventoryName);
await page.locator("#nb-qty").fill("10");
await settle(page, 300);
await shot(page, `${OUT}/07-shelf-box-new.png`);
await page.locator(".dialog").getByRole("button", { name: "建立", exact: true }).click();
await settle(page, 2500);

// 5. sub-inventories: share-group manager (left groups, right member checkboxes)
await page.goto("/sub-inventories");
await settle(page, 1200);
await page.locator(".page-head").getByRole("button", { name: "共享組", exact: true }).click();
await settle(page, 600);
// If no group exists, stage a draft group so the member pane renders (never saved).
const noGroups = await page.locator(".share-mgr-groups .muted").count();
if (noGroups) {
  await page.locator(".share-mgr-new input").fill("DEMO-GROUP");
  await page.locator(".share-mgr-new").getByRole("button", { name: "建立", exact: true }).click();
  await settle(page, 400);
}
await shot(page, `${OUT}/07-share-group-manager.png`);
await page.locator(".dialog .dialog-close").click();
await settle(page, 400);

await browser.close();
console.log("done");
