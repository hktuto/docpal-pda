# Excel-driven demo seed — design

Date: 2026-07-29
Status: approved

## Problem

The seeded demo world grew organically (hand-written KOA/DAITO orders, the
real-data 04958184/65878 orders + picking lists, order 210726, ten stock
boxes). Demoing the core flows — especially the new whole-box picking claim —
needs a small, purpose-built world the business can tweak without touching
TypeScript.

## Decisions

1. **The scenario is data, not code**: `new_seed/demo-scenario.xlsx`, one
   sheet per table. `scripts/gen-seed-demo-scenario.mjs` compiles it into
   `apps/backend/src/db/seed-demo-scenario.ts` (same generated-artifact
   pattern as `gen-seed-real-data.mjs`). Edit Excel → run the generator →
   `pnpm --filter @warehouse/backend db:seed`.
2. **Old seeded orders are removed** (demo KOA/DAITO + SO-2026-0001, real
   04958184/65878 + picking lists, 210726, 10 stock boxes). Master data stays:
   users/groups, suppliers (+162 bulk), parts (demo + ~100k bulk + realParts),
   sub-inventories + share members, shelves, profiles, net weights.
3. **The world tells one story**:
   - 2 receiving orders, both **pending**, each 2 cartons × 2-3 items, carton
     metadata (`boxSize`/`netWeight`/`grossWeight`/`weightUnit`) on every line
     → `additional_data`.
   - PO1 `SO-DEMO-0001` demand == shelf box `BOX-H-20260701-0001` contents →
     fully allocated + whole-box claim banner at seed time.
   - PO2 `SO-DEMO-0002` only partially covered by shelf stock; the shortfall
     sits on the pending receiving orders, so processing receiving completes
     it with mixed sources (shelf + receiving).

## Workbook sheets

`README` · `receiving_orders` (batchNo, supplierCode, deliveryDate, orgId,
subInventoryCode, status) · `receiving_invoices` (batchNo, invoiceNo,
supplierCode, wclCompanyName, deliveryDate — totals computed) ·
`receiving_items` (invoiceNo, ctnNo, partNo, wclItemNo, poNo, poLine, lineQty,
dateCode, lotCode, coo, cow + the four metadata columns) · `picking_orders`
(orderNo, poNo, deliveryDate, shipTo, customerCode, orgId, subInventoryCode) ·
`picking_items` (orderNo, partNo, qty) · `shelf_boxes` (boxId, shelfCode,
orgId, subInventoryCode, status) · `shelf_stock` (boxId?, shelfCode, partNo,
qty, dateCode, lotCode, coo, cow — blank boxId = loose lot).

## Generator rules

- `--init` writes the workbook with the initial scenario (refuses to
  overwrite without `--force`); default mode reads it and emits the TS file.
- Deterministic `uid(n)` ids; `demoParts` = every referenced partNo
  (brand = line supplier) inserted `onConflictDoNothing` so FKs never break.
- Validations fail fast with sheet/row in the message: invoiceNo → batchNo,
  orderNo/boxId references, positive integer quantities, weightUnit ∈ {g,kg}.
- `seed.ts` inserts the `demo*` arrays; shelf stock/boxes stay gated by the
  existing `stockBoxes` option (tests opt out), bulk parts by `bulkParts`.
