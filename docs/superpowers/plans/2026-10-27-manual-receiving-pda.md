# Manual Receiving (手動收貨) on PDA — Implementation Plan

Date: 2026-10-27
Spec: `docs/superpowers/specs/2026-10-27-manual-receiving-pda-design.md` (approved with the proposed defaults).

## Steps

1. **Backend domain** — `apps/backend/src/db/receivingCn.ts`:
   - `CnManualReceiptItem` / `CnManualReceiptOrder` types + `validateCnManualReceipt(raw)` (400 `invalid_payload` with field detail: orders non-empty, orderNo trims non-empty + unique space/case-insensitive per task, ≥1 item per order, partNo non-empty, qty positive integer; optional strings trim, empty → undefined).
   - `createCnManualReceipt(db, { orders, actor })` — one tx: `receiving_orders_cn` (`batch_no` = `generateCnBatchNo()`, `status: "in_hand"`, `arrived_at`/`arrived_by`, `org_id` 2 default) → per order `receiving_invoices_cn` (`invoice_no` = orderNo, `total_qty` = Σ qty) + `receiving_invoice_items_cn` (`line_qty` = `received_qty` = qty, batch fields, `wcl_item_no` resolved from `parts` on a unique space-insensitive `part_no` match, `additional_data` = `{raw, supplierCode, scannedBy}`) → `put_away_tasks_cn` (pair via the existing private `cnOrderPair` helper, org fallback = order org) → `transaction_logs` (`receiving_order_cn` NULL → `in_hand` with `metadata {source: "manual", orderNos}`; `put_away_task_cn` creation with `metadata.receivingOrderCnId`) → `emitEvent("receiving_cn.completed", topics ["/admin/receiving-cn", "/put-away-tasks"], { receivingOrderCnId, batchNo, source: "manual" })`. Returns `{ id, batchNo, putAwayTaskId }`.
2. **Backend route** — new `apps/backend/src/routes/receivingCn.ts`: `POST /receiving-cn/manual-receipts`, gated by `cnReceiving()` (404 `not_found` when off — same `assertCnEnabled` pattern as `putawayCn.ts`); actor from the JWT. Mount in `apps/backend/src/index.ts` next to `putawayCnRoute`.
3. **Backend tests** — `apps/backend/src/routes/receivingCn.test.ts` (mirror `admin/receivingCn.test.ts` setup: `_setCnReceivingForTests`, reseed): gate 404; validation matrix; happy path asserting the full `_cn` world + put-away task + audit rows + response shape; duplicate orderNo 400.
4. **PDA service** — `apps/pda/services/types.ts` (`CnManualReceiptItem/Order`, `CnManualReceiptResult`), `warehouse.ts` (`createCnManualReceipt(orders)` on the interface, CN section), `adapters/backendWarehouse.ts` (`client.post("/receiving-cn/manual-receipts", { orders })`).
5. **PDA page** — `apps/pda/pages/manual-receiving/index.vue`, one page two views:
   - Task view: 新增訂單號 input + 確定 (duplicate reject, toast); chips with `(itemCount/Σqty)` progress, 修改 (order-no dialog), 掃描; footer 取消 (confirm when draft non-empty → home) / 完成 (enabled when every order has ≥1 item and ≥1 order exists; confirm dialog → submit, button disabled while submitting → toast + `/put-away`).
   - Scan view: banner 掃描到 `<orderNo>`; hardware scan via `useScannerBroadcast` (+ `useHardwareScanner` fallback) and camera FAB via `captureLabel()` → `captureRawLabelValue` — both feed `useLabelScan().parseRawValue(raw)` (decode-only, no targets/supplier scope) → append item row (`partNo` = parsed `itemId`, qty/dateCode/lotCode/coo/cow, `raw`); exact-repeat `raw` within the order → toast, skipped. Rows: 修改 (dialog: partNo, qty, dateCode, lotCode, coo, cow) / 刪除 (confirm). Footer 取消 (discard this session's scans) / 完成掃描 (≥1 item required).
   - Item draft type + totals helpers in `apps/pda/utils/manualReceiving.ts` (+ vitest for totals/dup-orderNo).
6. **Home tile** — `apps/pda/pages/index.vue`: 手動收貨 card `v-if="cnReceiving"` → `/manual-receiving`, new icon modifier class.
7. **i18n** — `manualReceiving.*` subtree in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`.
8. **Verify** — `pnpm --filter @warehouse/backend test`, `pnpm --filter @warehouse/backend build` (tsc), `pnpm --filter @warehouse/pda test`, `pnpm --filter @warehouse/pda nuxt prepare`.
9. **Docs** — `docs/backend/api-design.md` (new route), `docs/app-docs/ai/feature-registry.md` + `code-map.md` + `flows/receiving/ai-scope.md` (manual receiving replaces the Excel phase-1 path), spec status → implemented.

## Notes / decisions (from spec open items, defaulted)

- Item row line 2 = date code + qty; `org_id` defaults 2, `sub_inventory_code` NULL; duplicate exact-`raw` label within an order rejected with a toast; no manual add without a scan; `supplierCode` stored per item in `additional_data`; admin list unchanged (workflow columns "—" for manual orders).
