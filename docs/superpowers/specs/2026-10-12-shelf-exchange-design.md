# Shelf Exchange — design

Date: 2026-10-12

Enables operators to move stock from one shelf to another (shelf
rearrangement) from the PDA. Scan-driven, order-free, one item per cycle:
source shelf → item label (qty comes from the label) → target shelf →
confirm.

## Operator flow

1. Open **Shelf Exchange** from the home tile.
2. **Scan the source shelf** QR — matched against `shelves.code`; shown in a
   sticky banner with a clear button.
3. **Scan the item label** in that shelf (hardware gun QR, or camera capture).
   The label is parsed like other scan flows (supplier QR templates, then
   generic OCR fallback); **qty comes from the label** — no manual entry. The
   PDA calls the backend preview, which resolves the stock lot on the source
   shelf and validates availability. Mismatch/no stock → error toast, stay in
   step 3.
4. **Scan the target shelf** QR — must exist and differ from the source.
5. **Confirm dialog** shows part, batch fields, qty, source → target shelf.
   Confirm commits the move; success toast; item + target clear, **source
   shelf stays selected** (repeat from step 3 for more items on the same
   shelf). Clearing the banner restarts from step 2.

## Scope decisions

- **Item matching = lot by label fields** (part_no / wcl_item_no space-
  insensitive, date code + lot code must match when the label carries them),
  FIFO by `date_code` — same resolution style as the picking shelf-scan
  (`resolveScannedShelfLot`), minus order org/sub-inventory context.
- **Qty = label qty** (validated: positive integer, ≤ the lot's *available*
  qty).
- **Merge on target**: if the target shelf already holds a lot with the same
  unique-index batch key (part_no, date_code, coo, cow, org_id,
  sub_inventory_code), qty is added to that lot; else a new lot row is
  created (shelf-level, `box_id` NULL). This matches the DB unique-lot index
  and put-away/ad-hoc merge semantics. Note the unique index does **not**
  include `lot_code` — a merged lot keeps the *target* lot's lot_code.
- **Target shelf: existence check only** (no org/sub-inventory scope
  validation; `shelves` has no org column and its `sub_inventory_scopes` is
  advisory). The moved lot keeps its own (org_id, sub_inventory_code) pair.
- **Allocated stock cannot be moved**: the move is capped at the lot's
  available qty (`total_qty - allocated_qty`); beyond that → 409
  `insufficient_available_qty`. Rationale: moving allocated qty would leave
  `allocated_qty > total_qty` and break picks that hold a work lock
  (allocation recompute skips locked orders). De-allocate or finish the
  order first.

## Architecture

### Data model

**New table `shelf_exchanges`** (audit — mirrors `ad_hoc_put_aways`):
one row per confirmed move.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID v7 |
| `source_shelf_code` | text FK → shelves | |
| `target_shelf_code` | text FK → shelves | |
| `source_lot_id` | text FK → inventory_lots | resolved lot |
| `target_lot_id` | text FK → inventory_lots | created/merged lot |
| `part_no` | text | plain text, no FK |
| `wcl_item_no` | text | nullable |
| `qty` | integer | moved qty |
| `date_code` / `lot_code` / `coo` / `cow` | text | label snapshot |
| `org_id` / `sub_inventory_code` | integer / text | from the source lot |
| `actor_id` | text FK → users | from JWT |
| `created_date` / `last_update_date` | timestamptz | |

**`inventory_lots`** — reused. Source lot `total_qty -= qty`; target lot
find-or-create (unique-index key, `box_id` NULL) `total_qty += qty`.
Allocated qty untouched.

**`inventory_transactions`** — two `on_hand` ledger rows per move (−qty at
source shelf, +qty at target shelf) with a new `txnType: "MOVE"`,
`referenceType: "shelf_exchange"`, `referenceId` = the audit row id, actor
from JWT. Goods-verify generation keys off any lot movement, so both lots
get next-day verify tasks — accepted (same as ADJUST rows today).

### Backend

**New domain module `src/db/shelfExchange.ts`** + **route file
`src/routes/shelfExchange.ts`** (thin routes, `HTTPException` snake_case
errors, mounted in `src/index.ts` like the other flow routes).

#### `POST /shelf-exchange/preview`

Request: `{sourceShelfCode, partNo?, wclItemNo?, qty, dateCode?, lotCode?,
coo?, cow?}` (PDA-parsed label fields).

Logic: validate source shelf exists (404 `shelf_not_found`); resolve the
lot on that shelf — part keys matched space-insensitively against
`part_no`/`wcl_item_no`, `date_code`/`lot_code`/`coo`/`cow` must match when
carried, `allowedOrgFilter`, exclude lots whose shelf is missing from
`shelves` (FK-update guard, same as picking), FIFO `date_code ASC NULLS
LAST`. Lot with `total_qty >= qty` required, else 409
`no_stock_at_location`; `available_qty < qty` → 409
`insufficient_available_qty`.

Response: `{lotId, partNo, wclItemNo, dateCode, lotCode, coo, cow,
totalQty, availableQty, qty}`.

#### `POST /shelf-exchange`

Request: `{sourceShelfCode, targetShelfCode, lotId, qty}`.

Logic (single transaction; the lotId pins the exact lot previewed):
1. Validate lot exists, `shelf_code == sourceShelfCode` (409
   `no_stock_at_location` on drift), `total_qty >= qty` and available ≥ qty
   (409 `insufficient_available_qty`).
2. Validate target shelf exists (404 `shelf_not_found`) and differs from
   source (400 `same_shelf`).
3. Source `total_qty -= qty`; find-or-create target lot (unique-index key,
   `box_id` NULL, org/sub-inventory copied from source) `total_qty += qty`.
4. Insert `shelf_exchanges` audit row; two `inventory_transactions` rows
   (MOVE / on_hand, −qty source, +qty target, referenceId = audit id).
5. `scheduleAllocateAll` after commit (location change; same pattern as
   ad-hoc put-away).

Response: `{id, sourceShelfCode, targetShelfCode, partNo, qty,
sourceRemaining, targetTotal}`.

### Flow step

`shelf-exchange` added to backend `FLOW_STEPS` (`src/config.ts`) — served
on `GET /config`, toggleable in the admin flow-config page (its `STEPS`
list gains the key too). PDA `FlowStep` union + `useFlowSteps` default +
home tile with icon. Enabled by default; `WAREHOUSE_CODE`-specific configs
can disable it.

### PDA

**New page `pages/shelf-exchange/index.vue`** — single page, step state
machine (source shelf / item / target shelf / confirm):

- **Shelf detection**: scans matched against `getShelves()` (cached,
  case-insensitive). Step rules: awaiting source → set source; awaiting
  item + shelf scanned → replace source; awaiting target → set target
  (400-style client check when equal to source).
- **Item parse**: hardware scan → `parseQrCapture` with supplier templates,
  no brand context (all templates tried, first match wins — same trade-off
  as ad-hoc put-away before brand selection); camera path via
  `captureLabel` + QR-only `parseQrCapture` / `parseAndIdentify` fallback.
- **Service**: `previewShelfExchange()` → matched-lot banner (part, batch,
  qty, available) once step 3 completes; `commitShelfExchange()` on
  confirm.
- **Confirm dialog**: new `components/ShelfExchangeConfirmModal.vue` —
  part, batch fields, qty, source → target; confirm/cancel.
- **Scanner symbology**: no supplier/brand context exists → no whitelist
  applied (`withShelfCodes: true` semantics — shelf QRs stay decodable);
  same limitation as ad-hoc put-away.

### i18n

New keys in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`:
`meta.shelfExchange`, `home.menu.shelfExchange.title`, `shelfExchange.*`
(step hints, banners, matched-lot card, confirm dialog, toasts, errors:
`no_stock_at_location`, `insufficient_available_qty`, `same_shelf`,
`shelf_not_found`, scan parse failure).

### Docs

`docs/backend/api-design.md` (new section), `docs/backend/schema-tables.md`
(new table), `docs/app-docs/flows/shelf-exchange/{overview.md,steps.md,
ai-scope.md}`, `docs/app-docs/ai/feature-registry.md` +
`ai/code-map.md`.

## Out of scope

- Moving allocated stock (see Scope decisions) — an admin override could
  come later.
- Multi-item batch moves in one commit (flow is one item per confirm).
- Box-level exchange (target is always a shelf; source lots may live in a
  box — only the lot qty is moved, the `shelf_box_items` manifest is
  untouched, same as picking).
- Supplier symbology whitelist (no supplier context on this page).
- Outdated date-code warnings (stock move, not a receiving/picking scan).
- Admin history view (audit table is the source of truth; UI can follow).
- Stock-search / list SSE events (pages refetch on visibility regain).

## Tests

Backend `src/db/shelfExchange.test.ts` (node:test):

- Preview resolves a lot by part keys + label batch fields, FIFO order,
  space-insensitive part match.
- Preview 404 unknown source shelf; 409 no lot at location; 409
  insufficient available (allocated cap).
- Commit moves qty: source decremented, target lot created with
  org/sub-inventory copied, two MOVE ledger rows, audit row with actor.
- Commit merges into an existing target lot with the same batch key.
- Commit 400 same shelf; 404 unknown target shelf; 409 lot drift (wrong
  source shelf); 409 insufficient available.
- Moved lot excluded when its shelf is missing from `shelves`.

PDA: page flow is scan-driven and page-level (same as put-away pages, not
unit-tested); service adapter methods covered in
`backendWarehouse.test.ts` style if needed.

## Files

- `apps/backend/src/db/schema/shelfExchange.ts` — new table (+ export from
  `schema/index.ts`), migration via `db:generate`.
- `apps/backend/src/db/shelfExchange.ts` — domain logic.
- `apps/backend/src/routes/shelfExchange.ts` — routes.
- `apps/backend/src/index.ts` — mount route.
- `apps/backend/src/config.ts` — `FLOW_STEPS` += `shelf-exchange`.
- `apps/backend/src/db/shelfExchange.test.ts` — tests.
- `apps/admin/pages/flow-config.vue` — `STEPS` += `shelf-exchange`.
- `apps/pda/pages/shelf-exchange/index.vue` — page.
- `apps/pda/components/ShelfExchangeConfirmModal.vue` — confirm dialog.
- `apps/pda/pages/index.vue` — home tile.
- `apps/pda/services/types.ts` + `warehouse.ts` +
  `adapters/backendWarehouse.ts` — DTOs + service methods.
- `apps/pda/composables/useFlowSteps.ts` — default record.
- `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — strings.
- `docs/backend/api-design.md`, `docs/backend/schema-tables.md`,
  `docs/app-docs/**` — docs.
