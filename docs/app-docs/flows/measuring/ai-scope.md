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
- `apps/api/src/routes/measuring.ts` — `GET /measuring-tasks` list/polling endpoint (filter by `status`, `since`; includes `total_items`/`packed_items` totals), `GET /measuring-tasks/:id` detail, and `POST /measuring-tasks/:id/complete`.
- `apps/api/src/routes/boxes.ts`, `apps/api/src/db/measure.ts` — measuring execution now lives in the API: `GET /shipping-boxes/:id/for-measuring`, `POST /shipping-boxes/:id/verify-package`, `PATCH /shipping-boxes/:id` (measurements), `POST /shipping-boxes/:id/close`.

## API semantics (Plan 5)

- A box can be `closed` only when it is non-empty, every package is verified, and `box_size`, weights, and a destination are set; `destination_country` falls back to the picking order's `destination_country`, then `ship_to`, at close time.
- `POST /measuring-tasks/:id/complete` requires all boxes closed and all items fully packed; on completion it auto-creates a `pre_shipment` verification task for the order (see [goods-verify ai-scope](../goods-verify/ai-scope.md)).
- Pre-shipment verification is box-level (`closed → verified`); cycle-count verification is still pending (Plan 6).

## Known limitations

- Measurements are typed manually.
- No real weight or dimension capture.

## Related specs/plans

- `docs/superpowers/specs/2026-07-02-measuring-flow-design.md`
- `docs/superpowers/specs/2026-07-03-boxes-section-redesign-design.md`
- `docs/superpowers/plans/2026-07-12-picking-execution.md`
- `docs/superpowers/plans/2026-07-12-measuring-verification.md`
