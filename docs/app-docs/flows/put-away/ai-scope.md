# Put-away — AI Scope and Remarks

## In scope

- List put-away tasks.
- Show detail with receiving-area items.
- Scan physical pieces into a receiving item, then move whole scanned pieces into shelf boxes.
- Select a destination shelf.
- Update inventory lot locations.

## Out of scope

- Automated put-away suggestions based on velocity or zone.
- Forklift or robot integration.
- Multi-step directed put-away with confirmation checkpoints.

## Key files

- `pages/put-away/index.vue` — list page.
- `pages/put-away/[id].vue` — detail page.
- `components/put-away/PutAwayLotsPanel.vue` — receiving items and scan management.
- `components/put-away/ShelfBoxesPanel.vue` — open shelf boxes and piece assignment.
- `components/SelectShelfDialog.vue` — shelf selection UI.
- `db/putAway.ts` — put-away DB helpers (pglite adapter only; api mode: `apps/api/src/db/putAway.ts` behind `routes/putAway.ts`).
- `apps/api/src/routes/putAway.ts` — API routes: scan pool, shelf-box lifecycle, put-away reads (`GET /put-away/candidates`, `.../put-away-lots`, `.../put-away-scans`, `.../shelf-boxes`).
- `apps/api/src/db/putAway.ts` — tx-scoped API primitives (`recordPutAwayScan`, `assignScanToBox`, `addAllUnboxedToBox`, `removeScanFromBox`, `closeShelfBox`, `scheduleCycleCount`).

## API implementation (Plan 6)

- The put-away flow is implemented API-first in `apps/api`; the web pages run on these endpoints by default (`warehouseAdapter: "api"`) via `services/adapters/apiWarehouse.ts`, with the PGlite path (`db/putAway.ts`) still available behind `warehouseAdapter: "pglite"`.
- `assignScanToBox` materializes an `inventory_lots` row for the boxed pieces and reduces the receiving item's `available_qty`; it also schedules a `cycle_count` verification task for the box.
- Receiving clear: when the last unboxed piece of an `in_hand` order is assigned and its box closes, the order flips to `status='clear'` (inside `assignScanToBox` / `closeShelfBox`).
- `shelf_box_items` exists in the schema but is intentionally unused — box contents aggregate live from `put_away_scans` grouped by `shelf_box_id` + `part_id`.

## Known limitations

- Shelf selection is manual.
- No validation of shelf capacity or restrictions.
- Scanned pieces are tracked per receiving invoice item. The app does not support splitting a single scanned piece across multiple boxes.
- API: the `shelves` table has no `zone` column (unlike the web app), and there is no HTTP endpoint to create shelves — tests/seed insert rows directly.

## Related specs/plans

- `docs/superpowers/specs/2026-07-03-cancel-empty-box-design.md`
- `docs/superpowers/specs/2026-07-06-put-away-scan-first-design.md`
- `docs/superpowers/plans/2026-07-06-put-away-scan-first.md`
- `docs/superpowers/plans/2026-07-13-put-away-cycle-count.md`
