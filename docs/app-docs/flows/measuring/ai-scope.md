# Measuring — AI Scope and Remarks

## In scope

- List measuring tasks for finished picking orders.
- Show task detail with items to pack.
- Create shipping boxes.
- Record box measurements (length, width, height, weight).
- Pack picking items into shipping boxes.
- Finish the measuring task.

## Out of scope

- Carrier rate shopping.
- Label printing for shipping boxes.
- Integration with scales or dimensioners.
- Multi-package shipment optimization.

## Key files

- `pages/measuring/` — list and detail pages.
- `components/BoxMeasurementsModal.vue` — measurement entry.
- `services/warehouse.ts` — service interface.
- `services/adapters/pgliteWarehouse.ts` — PGlite service implementation.
- `db/measuring.ts` — measuring DB helpers (called only by the adapter).
- `apps/api/src/db/pickScan.ts` — `maybeAutoFinishPickingOrder` creates the measuring task: when a pack/bulk-pack/finish leaves every picking item fully boxed, the order flips to `finished` and a `measuring_tasks` row is inserted with `ON CONFLICT (picking_order_id) DO NOTHING` (at most one task per picking order).
- `apps/api/src/routes/measuring.ts` — `GET /measuring-tasks` list/polling endpoint (filter by `status`, `since`) over those API-created tasks.

## Known limitations

- Measurements are typed manually.
- No real weight or dimension capture.

## Related specs/plans

- `docs/superpowers/specs/2026-07-02-measuring-flow-design.md`
- `docs/superpowers/specs/2026-07-03-boxes-section-redesign-design.md`
- `docs/superpowers/plans/2026-07-12-picking-execution.md`
