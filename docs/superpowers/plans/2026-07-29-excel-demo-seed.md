# Excel-driven demo seed: 2 receiving + 2 picking orders (whole-box claim scenario)

## Decisions (confirmed with user)

- **"1 box fully match" = whole order == one box**: one picking order's entire
  demand exactly equals one shelf box's contents (demos the new whole-box
  claim). The box is seeded already on-shelf.
- **Both receiving orders pending** — the operator walks confirm-arrival →
  scan → put-away on the PDA; their stock becomes allocatable only after that.
- **Remove all old seeded orders**: demo KOA/DAITO orders + SO-2026-0001, real
  04958184/65878 + picking lists, 210726, and the 10 demo stock boxes go away.
  Keep master data: users/groups, suppliers (+162 bulk), parts (demo + ~100k
  bulk), sub-inventories + share members, shelves, customer/country/box-size
  profiles, net weights (demo + real), supplier profiles.
- **The scenario lives in an editable Excel workbook** with one sheet per
  table; a generator script turns it into the TS seed artifact (same pattern
  as `scripts/gen-seed-real-data.mjs`, root `xlsx` package).

## Demo story (what the seeded world shows)

- At seed time: **PO1 fully allocated** from one shelf box whose contents
  exactly match it → the picking detail shows the "Use whole box" banner.
  **PO2 only partially allocated** from shelf stock.
- After the operator processes the two receiving orders, PO2 becomes fully
  allocated with **mixed sources (shelf + receiving)** — the "some in
  inventory and some on receiving order" journey.

## Workbook: `new_seed/demo-scenario.xlsx` (7 data sheets + README)

| Sheet | Columns |
|---|---|
| `README` | usage instructions (edit → `node scripts/gen-seed-demo-scenario.mjs` → `pnpm --filter @warehouse/backend db:seed`) |
| `receiving_orders` | batchNo, supplierCode, deliveryDate, orgId, subInventoryCode, status |
| `receiving_invoices` | batchNo, invoiceNo, supplierCode, wclCompanyName, deliveryDate (totalQty/totalCtn computed by the generator from items) |
| `receiving_items` | invoiceNo, ctnNo, partNo, wclItemNo, poNo, poLine, lineQty, dateCode, lotCode, coo, cow, boxSize, netWeight, grossWeight, weightUnit (last four → `additional_data`) |
| `picking_orders` | orderNo, poNo, deliveryDate, shipTo, customerCode, orgId, subInventoryCode |
| `picking_items` | orderNo, partNo, qty |
| `shelf_boxes` | boxId, shelfCode, orgId, subInventoryCode, status |
| `shelf_stock` | boxId (blank = loose lot), shelfCode, partNo, qty, dateCode, lotCode, coo, cow |

### Initial contents

- RO `100001` (KOA, pending, org 2/STORE1), invoice `INV-100001-01`:
  carton `C1001`: RK73H1JTTD1002F ×2000, RK73H1JTTD2202F ×1000;
  carton `C1002`: RK73B1JTTD181G ×1500, RK73H2ATTD1372F ×800, P413 ×500.
  Each row carries carton metadata (boxSize/net/gross in grams).
- RO `100002` (DAITO, pending, org 2/STORE1), invoice `INV-100002-01`:
  carton `C2001`: P413 ×1200, RK73B1JTTD181G ×600;
  carton `C2002`: RK73H2ATTD1372F ×900, RK73H1JTTD1002F ×400, RK73H1JTTD2202F ×300.
- Shelf boxes: `BOX-H-20260701-0001` (A-01-01, closed): 1002F ×1000 + 2202F
  ×500; `BOX-H-20260701-0002` (A-01-02, closed): 181G ×400 + P413 ×200.
- PO1 `SO-DEMO-0001` (ACME, org 2/STORE1): 1002F ×1000, 2202F ×500 — exact
  match of BOX-…-0001 → fully allocated + claim banner.
- PO2 `SO-DEMO-0002` (ACME, org 2/STORE1): 181G ×1000 (400 on shelf),
  P413 ×600 (200 on shelf), 1372F ×700 (none) → partial; the shortfall sits
  on the two pending receiving orders.

## Implementation steps

### 1. Spec
`docs/superpowers/specs/2026-07-29-excel-demo-seed-design.md`.

### 2. Generator `scripts/gen-seed-demo-scenario.mjs`
- `--init`: writes `new_seed/demo-scenario.xlsx` with the initial contents
  above (idempotent; refuses to overwrite without `--force`).
- default: reads the workbook → writes
  `apps/backend/src/db/seed-demo-scenario.ts` (GENERATED header) exporting
  typed arrays: `demoParts` (distinct partNos referenced anywhere, brand =
  line supplier, `onConflictDoNothing` so FK never breaks), `demoReceivingOrders`,
  `demoReceivingInvoices` (totals computed), `demoReceivingInvoiceItems`
  (`additionalData` from the metadata columns), `demoPickingOrders`,
  `demoPickingItems`, `demoShelfBoxes`, `demoShelfBoxItems`, `demoLots`.
  Deterministic `uid(n)` ids like the existing generator.
- Validation with clear errors: every invoiceNo belongs to a batchNo, every
  picking item's orderNo exists, boxId in shelf_stock exists in shelf_boxes,
  qty/lineQty positive integers, weightUnit ∈ {g, kg}.

### 3. Rewire `apps/backend/src/db/seed.ts`
- Remove: demo receiving orders/invoices/items block + cleared-order lots/lot
  sources; the 10 stock boxes + their lots/shelf_box_items (`stockBoxes`
  block); SO-2026-0001; `realReceivingOrders/Invoices/Items` +
  `realPickingOrders/Items` inserts; the 210726 block (drop the
  `seed-order-210726.js` import — generated files stay on disk, only the
  seeding stops; `realParts` from seed-real-data.ts stays as master data).
- Add: insert the `demo*` arrays (parts first with `onConflictDoNothing`;
  `demoLots`/`demoShelfBoxes`/`demoShelfBoxItems` gated by the existing
  `stockBoxes` option, now meaning "scenario shelf stock").
- Keep: users/groups, suppliers, parts (demo + bulk), sub-inventories +
  share members, shelves, profiles, net weights, `realParts`, priority_seq
  backfill, `bulkParts` option.
- Delete `apps/backend/src/db/seed-order-210726.ts` import only (file stays).

### 4. Adapt the backend test suite (~13 files, ~127 refs to old world)
Per-file passes, mostly business-key/qty swaps onto the new world
(receiving.test.ts is the biggest, then putaway/picking):
- New keys: batches `100001`/`100002` (pending), orders `SO-DEMO-0001/0002`,
  boxes `BOX-H-20260701-0001/0002`, invoices `INV-100001-01/INV-100002-01`.
- Tests that need a cleared/received order confirm arrival or set
  received_qty themselves (several already do); tests asserting exact stock
  counts get the new quantities.
- Delegate per-file adaptation to subagents once the seed compiles; run the
  full suite serially until green.

### 5. Docs
- `AGENTS.md` seed paragraph: new demo world + Excel workflow
  (`new_seed/demo-scenario.xlsx` → `scripts/gen-seed-demo-scenario.mjs` →
  `db:seed`); note old orders removed.
- `docs/backend/README.md` seed section + `docs/app-docs` references to
  SO-2026-0001 / batch numbers if any.

### 6. Verify
- `node scripts/gen-seed-demo-scenario.mjs --init` + default run.
- `pnpm --filter @warehouse/backend build`, full backend suite (serial),
  web suite.
- `pnpm --filter @warehouse/backend db:seed` against the dev DB, then
  browser check: receiving list = 2 pending orders with 2 cartons each;
  picking list = SO-DEMO-0001 allocated (+ banner on detail) /
  SO-DEMO-0002 partial.
- Edit one qty in the xlsx, regenerate, reseed — prove the edit round-trips.
