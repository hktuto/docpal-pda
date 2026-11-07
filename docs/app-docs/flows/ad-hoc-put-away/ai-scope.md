# Ad-hoc Put-away — AI Scope

## Files

| File | Purpose |
|------|---------|
| `apps/pda/pages/ad-hoc-put-away/index.vue` | Main page — brand selection, scan handling, item list, location/shelf selection, confirm |
| `apps/pda/services/types.ts` | `AdHocPutAwayItem`, `AdHocPutAwayResult`, `AdHocPutAwayLocation` DTOs |
| `apps/pda/services/warehouse.ts` | `getAdHocPutAwayBrands()`, `getAdHocPutAwayLocations()`, `lookupAdHocPutAwayPart()`, `commitAdHocPutAway()` interface methods |
| `apps/pda/services/adapters/backendWarehouse.ts` | HTTP implementation of the above |
| `apps/backend/src/db/adhocPutaway.ts` | Domain logic — `commitAdHocPutAway()`, `listAdHocPutAwayBrands()`, `listAdHocPutAwayLocations()` |
| `apps/backend/src/routes/adhocPutaway.ts` | Route handlers — `GET /ad-hoc-put-away/brands`, `GET /ad-hoc-put-away/locations`, `GET /ad-hoc-put-away/part-lookup`, `POST /ad-hoc-put-away` |
| `apps/backend/src/db/schema/adhocPutaway.ts` | `ad_hoc_put_aways` table schema |
| `apps/backend/src/db/adhocPutaway.test.ts` | Backend tests |

## Data model

- **`ad_hoc_put_aways`** — one row per confirmed batch (audit). Items stored as JSONB.
- **`inventory_lots`** — reused. Find-or-create per item, keyed by `(part_no, shelf_code, date_code, lot_code, coo, cow, org_id, sub_inventory_code)`.
- **`inventory_transactions`** — reused. `txnType: "ADJUST"`, `qtyType: "on_hand"`, positive delta.

## Composables used

- `useWarehouse()` — service layer
- `useToast()` — success/error messages
- `useHardwareScanner()` — hardware scanner input
- `useLabelScan()` — `captureLabel()` camera OCR only (no review modal on this page — parsed labels go straight into the staged list; multi-line OCR text falls back to local `utils/parseOcrScan.ts`, single codes to `POST /scan/decode` via `utils/labelDecode.ts`)
- `useBrandSymbologyScope()` (from `composables/useScannerConfig.ts`, `{withShelfCodes: true}`) — scanner symbology whitelist for the selected brand
- `useErrorMessage()` — error display

## Behavior notes

- Duplicate scans are rejected **within the batch** by raw scan string
  (`seenScanKeys`, `raw:<full string>`; camera path degrades to `serial:`).
- Commit is brand+shelf required; unknown parts 404 `part_not_found`; on
  match the master's `part_no`/`wcl_item_no` **replace** the scanned identity.
- Shelf selection is scan-only (no dropdown; `SelectShelfDialog.vue` is
  unreferenced dead code).
- Known naming drift: request field / table column / query param are all
  `brand`, while `docs/backend/api-design.md` and the spec prose say
  `supplierCode` — and the admin list page filters by `supplierCode` which
  the backend ignores (see BUG-049).

## i18n keys

- `meta.adHocPutAway` — page title
- `home.menu.adHocPutAway.title` — home tile title
- `adHocPutAway.*` — page-specific strings (supplier, location, shelf, scan, items, confirm, etc.)
