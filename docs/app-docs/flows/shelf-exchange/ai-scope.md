# Shelf Exchange — AI Scope

## Files

| File | Purpose |
|------|---------|
| `apps/pda/pages/shelf-exchange/index.vue` | Main page — step state machine (source shelf → item label → target shelf), hardware scan + camera capture, confirm modal |
| `apps/pda/components/ShelfExchangeConfirmModal.vue` | Confirm dialog — resolved lot + qty + source → target route |
| `apps/pda/services/types.ts` | `ShelfExchangePreview`, `ShelfExchangeResult` DTOs; `FlowStep` += `"shelf-exchange"` |
| `apps/pda/services/warehouse.ts` | `previewShelfExchange()`, `commitShelfExchange()` interface methods |
| `apps/pda/services/adapters/backendWarehouse.ts` | HTTP implementation of the above |
| `apps/pda/composables/useFlowSteps.ts` | Default flow-step record includes `shelf-exchange: true` |
| `apps/backend/src/db/shelfExchange.ts` | Domain logic — `previewShelfExchange()`, `commitShelfExchange()` |
| `apps/backend/src/routes/shelfExchange.ts` | Route handlers — `POST /shelf-exchange/preview`, `POST /shelf-exchange` |
| `apps/backend/src/db/schema/shelfExchange.ts` | `shelf_exchanges` audit table schema |
| `apps/backend/src/db/shelfExchange.test.ts` | Backend tests |
| `apps/admin/pages/flow-config.vue` | `shelf-exchange` in the flow-steps checkbox list |

## Data model

- **`shelf_exchanges`** — one row per confirmed move (audit only).
- **`inventory_lots`** — the qty moves between the source lot (decremented, deleted at zero) and the target lot (find-or-create on the unique-lot index key `part_no + date_code + coo + cow + shelf_code + box_id NULL + org_id + sub_inventory_code`; merged lot keeps the target's `lot_code`).
- **`inventory_transactions`** — two `txnType: "MOVE"` rows per move (`reference_type: "shelf_exchange"`): −qty on the source lot, +qty on the target.

## Flow config

`shelf-exchange` is a flow step (`FLOW_STEPS` on the backend, admin flow-config page); disabling it hides the home tile.

## Composables used

- `useWarehouse()` — service layer
- `useToast()` — success/error messages
- `useHardwareScanner()` — hardware scanner input (handler returns `false` on rejection; the composable beeps; disabled while the confirm modal is open)
- `useLabelScan()` + `utils/parseOcrScan.ts` — camera capture and label parsing
- `useBrandSymbologyScope()` — no brand context on this page, so no symbology whitelist is applied (shelf QRs stay decodable)
- `useVisibleReload()` — reload shelves on mount + visibility regain

## i18n keys

- `meta.shelfExchange` — page title
- `home.menu.shelfExchange.title` — home tile title
- `shelfExchange.*` — page strings (steps, banners, fields, confirm, errors)
- `admin.pages.flowConfig.steps."shelf-exchange"` — admin flow-config checkbox label

## Error codes (snake_case backend errors → i18n keys under `shelfExchange.errors`)

- `shelf_not_found` (404) — source or target shelf code not in `shelves`
- `no_stock_at_location` (409) — no lot on the source shelf matches the label
- `insufficient_available_qty` (409) — matched lot's unallocated qty < label qty
- `same_shelf` (400) — target equals source
