# Manual Receiving (手動收貨) on PDA — Design

Date: 2026-10-27
Status: Implemented (plan `docs/superpowers/plans/2026-10-27-manual-receiving-pda.md`).

## Summary

Replace CN receiving phase 1 (admin Excel upload → DocPal workflow → upstream sync) with a PDA-driven manual receiving flow (手動收貨). The operator creates a task on the PDA, adds one or more order numbers (訂單號), scans supplier labels into each order (hardware scanner or camera OCR), can edit/remove scanned items, confirms each order's scans, then confirms the whole task. On confirm, the backend writes the same `_cn` world the sync used to write — `receiving_orders_cn` + `receiving_invoices_cn` + `receiving_invoice_items_cn` — stamped `in_hand`, plus the dedicated `put_away_tasks_cn` task, in one transaction. No DocPal workflow is involved (phase 2 PDF+OCR stays a separate, parallel path).

## Current behavior

Phase 1 (`docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md`): the admin uploads the customer receiving Excel; the backend kicks a DocPal workflow (`receiving_cn_workflows`); the external upstream sync writes the `_cn` trio; the status cron finalizes (`finalizeCnOrder` in `src/db/receivingCn.ts`) — order → `in_hand` + arrived stamp + `put_away_tasks_cn` insert.

The Excel path is being retired (the UI form already switched to the phase-2 PDF upload). Manual receiving replaces it as the way `_cn` orders come into existence.

## Flow walkthrough (from the 手動收貨(PDA) mockup)

1. **Task screen** — title 手動收貨, an input 新增訂單號 with 確定. Confirming adds the order number as a chip with 修改 / 掃描 actions.
2. **修改** on a chip opens a dialog (修改訂單號) to correct the order number.
3. **掃描** opens the scan screen — banner 掃描到 `<orderNo>`, camera FAB (OCR), hardware-scanner input. Each decoded label appends an item row: line 1 = wcl item no (e.g. `KOA/RK73H1ETTP6041F`, falling back to the part no), line 2 = date code + qty (e.g. `2639-CN 30K`). Every row has 修改 (edit dialog: qty + batch fields) and 刪除 (remove).
4. **完成掃描** commits the scanned items into the order chip and returns to the task screen; the chip shows progress `<orderNo> (n/Σqty)` (e.g. `329063176T3 (5/125K)`). 取消 discards the scans made for that order since entering the scan screen.
5. Repeat 1–4 for more order numbers.
6. **完成** on the task screen (footer, next to 取消) asks for confirmation, then posts the whole task. On success the order exists (in_hand) with its put-away task → navigate to `/put-away`.

## Design decisions

- **PDA-local staging, single commit call.** The task draft (orders + items) lives only on the PDA until 完成 — same precedent as CN put-away ("local scan staging, no staging endpoints"). One endpoint creates everything atomically; there is no draft table, no resume, no multi-device editing. Leaving the page mid-task abandons the draft (confirm dialog on navigation away with staged data).
- **One task = one `receiving_invoices_cn` row** (revised 2026-10-28). A manual task is single-brand: the brand locks from the first scanned label whose matched supplier template resolves a brand (single-brand profile → `brands[0]`, otherwise the supplier code); later scans of a different known brand are rejected on the PDA. `invoice_no` = `[brand]-yyyymmdd-[seq]` (e.g. `TE-20261028-01`; seq = that brand's invoice count for the day + 1, 2-digit padded). The order's `batch_no` = the same invoice no (the `CN-…` generator is not used for manual receipts) and `delivery_date` = the record creation date. Scanned items = `receiving_invoice_items_cn` under that one invoice, `po_no` = the user-typed order number of the order they were scanned into.
- **po_no prefix → item org/sub-inventory** (revised 2026-10-28, `deriveCnManualOrgSub`): `319*`/`317*` → org 7 / SZSZ1; `329*`/`327*` → org 14 / GZSZ; `339*`/`337*` → org 5 / SHSZ; `349*`/`347*` → org 12 / BJSZ; anything else → org 7 / STORE1. The order's `org_id` = the derivation of the first order number. The referenced `org_info` pairs must exist (item FK).
- **Confirm = receipt moment**, mirroring `finalizeCnOrder`: order inserted directly as `status: "in_hand"` with `arrived_at` / `arrived_by` = the PDA user; items carry `line_qty = received_qty = scanned qty`. The idempotent `put_away_tasks_cn` insert uses the same uniform-pair derivation (`cnOrderPair` — NULL pair when items are mixed; org falls back to the order's org).
- **Label decode is client-side**, reusing the existing pieces without order/supplier context: `GET /scan-templates` + `parseOcrScan.ts` (QR-template match over all supplier templates — no brand scoping, since the task has no supplier; the matched template echoes back as `result.supplier` for the brand lock) and `useLabelScanReview` for the confirm/edit sheet. Item rows display `wcl_item_no` (falling back to part no). The PDA sends parsed structured fields per item (`wclItemNo`, `brand`, `supplierCode`, batch fields); `raw` (the scanned text) rides along in `additional_data` for traceability. When the client omits `wclItemNo`, the backend resolves it from `parts` (space-insensitive, same as scanParse).
- **No `receiving_cn_workflows` row** — there is no DocPal workflow. Manual orders appear directly in the admin CN order list (`listCnOrders` already reads `receiving_orders_cn`; workflow columns render "—") and the existing order detail/logs pages work unchanged.

## Backend

New PDA-facing route module `src/routes/receivingCn.ts` (user JWT, not admin), the whole surface gated by `cnReceiving()` like the admin CN routes (404 `not_found` when the step is off). Mounted in the route index.

### `POST /receiving-cn/manual-receipts`

Body:

```json
{
  "orders": [
    {
      "orderNo": "329063176T3",
      "items": [
        {
          "partNo": "KOA+RK73H1ETTP 6041F",
          "wclItemNo": "KOA/RK73H1ETTP6041F",
          "brand": "KOA",
          "qty": 10000,
          "dateCode": "2641",
          "lotCode": "…",
          "coo": "JP",
          "cow": "…",
          "ctnNo": "…",
          "supplierCode": "KOA",
          "raw": "<scanned label text>"
        }
      ]
    }
  ]
}
```

Validation (400 `invalid_payload` with a field detail): `orders` non-empty; each `orderNo` trims non-empty and is unique within the task (space/case-insensitive); each order has ≥1 item; each item has non-empty `partNo` and a positive-integer `qty`; at least one item carries `brand` (the task brand). Optional item strings trim; empty → NULL.

Domain: `createCnManualReceipt(db, input, actor)` in `src/db/receivingCn.ts` — one tx (revised 2026-10-28 for the single-invoice / po_no rules):

1. Brand = the first item `brand` across the orders (400 `invalid_payload` when none); inside the tx, `invoice_no` = `[brand]-yyyymmdd-[seq]` from a `COUNT` over `receiving_invoices_cn.invoice_no LIKE '<brand>-<ymd>-%'`.
2. Insert `receiving_orders_cn` (`batch_no` = invoice no, `status: "in_hand"`, `arrived_at`/`arrived_by` = now/actor, `delivery_date` = now, `org_id` = the first order number's derived org).
3. Insert ONE `receiving_invoices_cn` (`invoice_no`, `total_qty` = Σ all items, `total_ctn` NULL, `org_id` = order org) + every order's `receiving_invoice_items_cn` rows (`po_no` = the order number; `org_id`/`sub_inventory_code` = `deriveCnManualOrgSub(orderNo)`; `line_qty` = `received_qty` = qty; batch fields; `wcl_item_no` = client's, else resolved from `parts` when uniquely matched; `additional_data` = `{ raw, supplierCode, scannedBy }`).
4. Insert `put_away_tasks_cn` with the `cnOrderPair`-derived pair (org fallback = order org) — `ON CONFLICT DO NOTHING` not needed (fresh order) but kept for symmetry.
5. `transaction_logs`: `receiving_order_cn` (NULL → `in_hand`, metadata `{ source: "manual", orderNos: [...] }`) + `put_away_task_cn` creation row (`metadata.receivingOrderCnId` — the existing CN order-logs query picks it up).
6. `emitEvent` `receiving_cn.completed`, topics `["/admin/receiving-cn", "/put-away-tasks"]`, data `{ receivingOrderCnId, batchNo, source: "manual" }` — the admin CN list and the PDA put-away list both reload on their existing subscriptions.

Response 201: `{ id, batchNo, putAwayTaskId }`.

No allocation side effects (the CN world never feeds `allocateAll`; put-away completion already schedules it).

## PDA

- **Home tile** 手動收貨 on `pages/index.vue`, shown when `cnReceiving` is on (same flag that switches put-away to the CN world — a CN warehouse runs this flow; no new flow step).
- **New page** `pages/manual-receiving/index.vue` — single page with two internal views (same-wizard pattern as the admin upload page, avoids draft-loss through navigation):
  - *Task view*: 新增訂單號 input + 確定; order chips (orderNo, `(itemCount/Σqty)` once scanned, 修改 / 掃描); footer 取消 (back home; confirm when draft non-empty) / 完成 (disabled until ≥1 order has ≥1 item; confirm dialog → submit → success toast → `/put-away`).
  - *Scan view* (per order): banner 掃描到 `<orderNo>`; decoded scans append item rows (line 1 = `wclItemNo || partNo`; 修改 = edit dialog with partNo/wclItemNo/qty/dateCode/lotCode/coo/cow; 刪除 = remove with confirm); camera FAB = `RectangleDetection.scanLabel()` OCR path; footer 取消 / 完成掃描. 完成掃描 requires ≥1 item.
  - *Brand lock* (2026-10-28): the first scan that resolves a supplier template locks the task brand (`result.supplier` — single-brand profile → `brands[0]`, else the supplier code); a later scan of a different known brand is rejected with a toast. 完成 is blocked with a toast when no scan resolved a brand.
- **Draft state** inside the page (plain refs); the label-review sheet reuses `useLabelScanReview`. Scan inputs: `useScannerBroadcast` (fast path) + `useHardwareScanner` (fallback), and OCR via the existing rectangle-detection flow.
- **Service**: `WarehouseService.createCnManualReceipt(orders)` → adapter `backendWarehouse.ts` POST `/receiving-cn/manual-receipts`; types in `services/types.ts`.
- **i18n**: new `manualReceiving.*` subtree in the three `layers/i18n` locales.
- No symbology whitelist scoping on this page (no supplier context); OCR + hardware scans both accepted.

## Testing

- Backend (`src/routes/receivingCn.test.ts`, mirroring the admin CN test file): gate 404 when the step is off; validation errors (empty orders, duplicate orderNo, empty items, bad qty, missing brand); happy path — 201, order `in_hand` with arrived stamp and `batch_no` = the `[brand]-yyyymmdd-[seq]` invoice no, ONE invoice with `total_qty` over all orders, items with `po_no` + derived org/sub + batch fields + resolved `wcl_item_no`, put-away task with the derived pair, two audit-log rows, SSE event; invoice seq increments per brand per day; unmatched po_no prefix → org 7 / STORE1; idempotency is client-side (button disabled while submitting) — documented, not enforced.
- PDA (vitest): draft/item helpers (chip progress totals, duplicate-orderNo rejection) if any non-trivial logic lands in `utils/`.

## Open items

1. ~~**Item row second line**~~ Resolved 2026-10-28: line 1 is `wcl_item_no`, line 2 is date code + qty.
2. ~~**Order-level `org_id` / item `sub_inventory_code`**~~ Resolved 2026-10-28: the po_no prefix rules in Design decisions (no more org-2 default for manual receipts).
3. **Duplicate label policy** within one order: reject an exact-repeat `raw` with a toast (proposed default) vs merge qty.
4. **Manual item add** (no label, typed part no + qty) — not in the mockup; exclude unless requested.
5. **Supplier learning**: scans decode via supplier templates — record the matched `supplierCode` on the order for later reporting (stored per item in `additional_data`; no order-level column).
6. Whether the retired Excel path's `receiving_cn_workflows` tracking list needs a "manual" provenance filter on the admin page (currently indistinguishable except NULL workflow fields).
