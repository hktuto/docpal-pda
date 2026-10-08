# Ad-hoc Put-away — AI Scope

## Files

| File | Purpose |
|------|---------|
| `apps/pda/pages/ad-hoc-put-away/index.vue` | Main page — supplier selection, scan handling, item list, location/shelf selection, confirm |
| `apps/pda/services/types.ts` | `AdHocPutAwayItem`, `AdHocPutAwayResult`, `AdHocPutAwayLocation` DTOs |
| `apps/pda/services/warehouse.ts` | `getAdHocPutAwayLocations()`, `commitAdHocPutAway()` interface methods |
| `apps/pda/services/adapters/backendWarehouse.ts` | HTTP implementation of the above |
| `apps/backend/src/db/adhocPutaway.ts` | Domain logic — `commitAdHocPutAway()`, `listAdHocPutAwayLocations()` |
| `apps/backend/src/routes/adhocPutaway.ts` | Route handlers — `GET /ad-hoc-put-away/locations`, `POST /ad-hoc-put-away` |
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
- `useLabelScan()` — OCR capture and review
- `useSupplierSymbologyScope()` — scanner symbology whitelist
- `useErrorMessage()` — error display

## i18n keys

- `meta.adHocPutAway` — page title
- `home.menu.adHocPutAway.title` — home tile title
- `adHocPutAway.*` — page-specific strings (supplier, location, shelf, scan, items, confirm, etc.)
