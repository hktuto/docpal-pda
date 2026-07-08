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

## Known limitations

- Measurements are typed manually.
- No real weight or dimension capture.

## Related specs/plans

- `docs/superpowers/specs/2026-07-02-measuring-flow-design.md`
- `docs/superpowers/specs/2026-07-03-boxes-section-redesign-design.md`
