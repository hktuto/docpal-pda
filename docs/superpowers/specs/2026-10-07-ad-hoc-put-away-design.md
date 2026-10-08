# Ad-hoc put-away — design

Date: 2026-10-07

Enables operators to put away items that have **no receiving order** —
old store stock, write-out returns, or any item that needs to re-enter
inventory. The flow is supplier-driven (for scan/OCR parsing context),
order-free, and commits directly to a shelf in one confirmation.

## Operator flow

1. Open **Ad-hoc put-away** from the home tile.
2. Select a **supplier** — drives OCR/QR parsing (qty encoding, date-code
   encoding) and the scanner symbology whitelist. Persists across cycles.
3. **Scan** item labels (hardware gun QR or camera OCR with review modal).
   Each scan is parsed against the supplier profile and added to a list.
4. **Review** the list — items grouped by part, showing qty, date code,
   lot code, COO/COW. Mis-scans can be removed.
5. Set **location (org_id + sub_inventory_code)** — a single grouped
   dropdown, batch-applied to all items, with per-item override.
6. **Review & edit** — update date_code and lot_code by batch or per
   item. New items default date_code to today's date code (WWYY format).
7. **Scan a shelf code** or pick one from a dropdown.
8. **Confirm** — "Put N items (X pcs) to shelf Y?" — commits all items
   to that shelf in one transaction.
9. List clears; supplier stays selected. Repeat from step 3.

## Architecture

### Data model

**New table `ad_hoc_put_aways`** — one row per confirmed batch (audit):

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID v7 |
| `supplier_code` | text | selected supplier |
| `shelf_code` | text | destination shelf |
| `org_id` | integer | |
| `sub_inventory_code` | text | |
| `total_qty` | integer | sum of item qtys |
| `item_count` | integer | number of items |
| `actor_id` | text | from JWT |
| `created_date` | timestamptz | |
| `last_update_date` | timestamptz | |

Items are stored as a JSONB column `items` (array of `{partNo, wclItemNo,
qty, dateCode, lotCode, coo, cow, serialNo}`). The authoritative stock
record lives in `inventory_lots` + `inventory_transactions`; this table is
for audit and admin visibility only.

**`inventory_lots`** — reused. Lot key: `(part_no, shelf_code, date_code,
lot_code, org_id, sub_inventory_code)`. Find-or-create per item; increment
`total_qty` on match.

**`inventory_transactions`** — reused. `txnType: "ADJUST"`, `qtyType:
"on_hand"`, positive `qtyDelta`. `referenceType: "ad_hoc_put_away"`,
`referenceId` = the batch id. `actorId` from JWT.

### Backend

**New domain module `src/db/adhocPutaway.ts`** + **new route file
`src/routes/adhocPutaway.ts`** (thin routes over domain logic, following
the existing layering pattern).

#### `POST /ad-hoc-put-away`

Request:
```json
{
  "supplierCode": "SUP001",
  "shelfCode": "A-01-01",
  "items": [{
    "partNo": "ABC-123",
    "wclItemNo": "WCL-456",
    "qty": 100,
    "dateCode": "2617",
    "lotCode": "LOT-A",
    "coo": "CN",
    "cow": "CN",
    "serialNo": null,
    "orgId": 2,
    "subInventoryCode": "MAIN"
  }]
}
```

Logic (single transaction):
1. Validate shelf exists (`shelves` table).
2. Validate each item's part exists (`parts` table) — 404 on unknown part.
3. For each item: find-or-create `inventory_lots` row, increment
   `total_qty`, write `inventory_transactions` ledger row.
4. Insert `ad_hoc_put_aways` audit row.
5. Schedule `allocateAll` (background — new stock may affect picking).

Response: `{id, itemCount, totalQty, shelfCode}`.

#### `GET /ad-hoc-put-away/locations`

Returns valid `(org_id, sub_inventory_code)` pairs from `org_info` for the
PDA location selector. Response: `{locations: [{orgId,
subInventoryCode}]}`. The PDA renders these as a single grouped dropdown
(e.g. "HK / MAIN", "HK / ZONE-A").

### PDA

**New page `pages/ad-hoc-put-away/index.vue`** — single-page flow (no list
detail split; the "list" is the in-progress scan list).

**Flow step**: Add `ad-hoc-put-away` to the `FlowStep` union in
`services/types.ts` and `FLOW_STEPS` in `src/config.ts`. Home tile shows
when enabled.

**Supplier selection**: Dropdown of suppliers (from existing
`GET /admin/suppliers` or a lightweight supplier list endpoint). On
change, updates the symbology scope via `useSupplierSymbologyScope` and
the OCR parsing context.

**Scan handling**: Reuse `useHardwareScanner` + `useLabelScan` patterns
from the put-away detail page. Shelf QR codes are intercepted (matching
`shelves.code`) and set the selected shelf. Item labels are parsed via
`parseQrCapture` / `parseAndIdentify` with the supplier context.

**Item list**: Local ref (reactive array). Items grouped by part for
display. Each item shows: part no, qty, date code, lot code, COO/COW.
Per-item remove button. Running total (item count + total pcs).

**Date code & lot code editing**: New items default `dateCode` to today's
date code (WWYY format, e.g. "2640" for week 40 of 2026). Users can edit
`dateCode` and `lotCode` by batch (apply to all items) or per item
(expandable inline editor). This handles cases where the label is missing
or has an unreadable date/lot code.

**Location (org_id + sub_inventory_code)**: A single grouped dropdown
populated from `GET /ad-hoc-put-away/locations`. Batch apply sets all
items to the same pair. Per-item override via an expandable item editor.
No default — user must pick.

**Shelf selection**: Scan a shelf QR (intercepted by `useHardwareScanner`)
or pick from a dropdown (`warehouse.getShelves()`). Selected shelf shown
in a banner with a clear button.

**Confirm**: Button enabled when items exist and a shelf is selected.
Shows a confirm dialog with item count, total pcs, and shelf. On confirm:
`POST /ad-hoc-put-away` → success toast → clear item list (supplier
persists).

**OCR review**: Reuse `useLabelScan` + `LabelScanReviewModal` pattern.
The review context carries the supplier code for proper parsing.

**Scanner symbology**: `useSupplierSymbologyScope` with
`{withShelfCodes: true}` — shelf QR always decodable, item labels
restricted to supplier's `barcode_types`.

### i18n

New keys under `home.menu.adHocPutAway.title`, `adHocPutAway.*` (supplier,
items, shelf, confirm, success, errors).

## Out of scope

- Draft persistence (app crash loses the in-progress list — acceptable).
- Outdated date-code warnings (can reuse the supplier profile logic later).
- Admin review/approval workflow (ad-hoc put-away is immediate).
- Admin history view (audit table is the source of truth; UI can be added later).
- Moving ad-hoc put-away stock between shelves (reversal + re-commit).
- Unknown part handling (scan must match a known part; no manual entry).
- Barcode/QR label printing for ad-hoc items.

## Tests

- Backend `src/db/adhocPutaway.test.ts`:
  - Single item commit creates lot + ledger + audit row.
  - Multiple items with same part+shelf+batch merge into one lot.
  - Multiple items with different batch attrs create separate lots.
  - Unknown part → 404.
  - Unknown shelf → 404.
  - `GET /ad-hoc-put-away/locations` returns valid pairs.
- PDA: scan routing + confirm flow (page-level, not unit-tested — same
  as existing put-away pages).

## Files

- `apps/backend/src/db/schema/adhocPutaway.ts` — new table schema.
- `apps/backend/src/db/adhocPutaway.ts` — domain logic.
- `apps/backend/src/routes/adhocPutaway.ts` — route handlers.
- `apps/backend/src/db/adhocPutaway.test.ts` — tests.
- `apps/backend/src/config.ts` — add `ad-hoc-put-away` to `FLOW_STEPS`.
- `apps/backend/src/db/seed.ts` — no seed data needed.
- `apps/pda/pages/ad-hoc-put-away/index.vue` — main page.
- `apps/pda/pages/index.vue` — home tile.
- `apps/pda/services/types.ts` — `FlowStep` union + DTO types.
- `apps/pda/services/warehouse.ts` + `services/adapters/backendWarehouse.ts`
  — new service methods.
- `apps/pda/composables/useFlowSteps.ts` — include new step.
- `layers/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — new strings.
- `docs/backend/api-design.md` — new endpoint documentation.
- `docs/app-docs/flows/ad-hoc-put-away/` — operator docs.
- `docs/app-docs/ai/feature-registry.md` + `ai/code-map.md` — file mapping.
