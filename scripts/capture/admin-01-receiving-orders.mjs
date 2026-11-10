// Admin 01 收貨單 — 5 shots per docs/user-guide/admin/01-receiving-orders.md checklist.
// NOTE: this instance's flow config has allowedOrgIds=[7,14,5,12] while all
// receiving_orders are org_id=2, so the list is empty by default. The script
// temporarily adds org 2 (and enables the receiving step for the nav link),
// and adds an org-2 sub-inventory entry to the Administrator user scope
// (the list/detail endpoints AND scope with allowedOrgIds), then restores
// both after capture.
import { launch, login, adminContext, shot, settle } from "./lib.mjs";

const OUT = "/Users/seantsang/Documents/work/docpal-pda/docs/user-guide/admin/shots";
const API = "http://127.0.0.1:3002";
const ORDER_ID = "01M3JYSAQPW482R3AVWNHGAB5A"; // BATCH-2026-09-28-000406 (KOA, pending, 144 items)

const auth = await login();
const headers = { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" };

const cfgRes = await fetch(`${API}/admin/flow-config`, { headers });
if (!cfgRes.ok) throw new Error(`flow-config get failed: ${cfgRes.status}`);
const { config, stored, envOverride } = await cfgRes.json();
if (envOverride) throw new Error("FLOW_CONFIG env override active — aborting config tweak");

async function putConfig(body) {
  const res = await fetch(`${API}/admin/flow-config`, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`flow-config put failed: ${res.status} ${await res.text()}`);
}

async function putUserScopes(scopes) {
  const res = await fetch(`${API}/admin/user-profiles/administrator`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ subInventoryScopes: scopes }),
  });
  if (!res.ok) throw new Error(`user-scope put failed: ${res.status} ${await res.text()}`);
}

const profRes = await fetch(`${API}/admin/user-profiles`, { headers });
if (!profRes.ok) throw new Error(`user-profiles get failed: ${profRes.status}`);
const profiles = await profRes.json();
const origScopes = profiles.find((u) => u.username === "administrator")?.subInventoryScopes ?? [];
const tweakedScopes = [...origScopes, { orgId: 2, code: "STORE1" }]; // STORE1 exists under org 2 in org_info

// Tweak the raw stored row (PUT re-validates; the merged `config` carries
// derived keys the validator rejects).
const tweaked = structuredClone(stored);
tweaked.allowedOrgIds = [...new Set([...(tweaked.allowedOrgIds ?? []), 2])];
tweaked.steps = { ...(tweaked.steps ?? {}), receiving: { enabled: true } };

const browser = await launch();
try {
  await putConfig(tweaked);
  await putUserScopes(tweakedScopes);

  const ctx = await adminContext(browser, auth);
  const page = await ctx.newPage();

  // 1. receiving list page (status filter + search + table)
  await page.goto("/receiving");
  await page.waitForSelector("text=BATCH-", { timeout: 15000 });
  await settle(page, 800);
  await shot(page, `${OUT}/01-receiving-list.png`);

  // 2. status SearchableSelect expanded (four checkboxes)
  await page.locator(".filters .ssel-toggle").first().click();
  await settle(page, 400);
  await shot(page, `${OUT}/01-receiving-status-filter.png`);
  await page.keyboard.press("Escape");
  await settle(page, 300);

  // 3. detail top: order info + invoice item table
  await page.goto(`/receiving/${ORDER_ID}`);
  await page.waitForSelector("text=編輯詳情", { timeout: 15000 });
  await settle(page, 800);
  await shot(page, `${OUT}/01-receiving-detail-top.png`);

  // 4. edit modal (open only — do not save)
  await page.getByRole("button", { name: "編輯詳情" }).first().click();
  await settle(page, 600);
  await shot(page, `${OUT}/01-receiving-edit-modal.png`);
  await page.keyboard.press("Escape");
  await settle(page, 300);
  // if Escape didn't close it, click the cancel/close control
  const cancelBtn = page.locator(".dialog-actions .btn:not(.btn-primary), .dialog-close").first();
  if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click();
  await settle(page, 400);

  // 5. top-right action button row (重新整理/確認收貨/覆寫狀態 …)
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page, 300);
  await page.locator(".page-head").screenshot({ path: `${OUT}/01-receiving-detail-actions.png` });
  console.log("shot:", `${OUT}/01-receiving-detail-actions.png`);
} finally {
  // restore the originally stored flow config + user scope
  await putConfig(stored).catch((e) => console.error("CONFIG RESTORE FAILED:", e.message));
  await putUserScopes(origScopes).catch((e) => console.error("SCOPE RESTORE FAILED:", e.message));
  await browser.close();
}
console.log("done");
