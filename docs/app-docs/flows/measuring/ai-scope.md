# Measuring — AI Scope and Remarks

## In scope

- List measuring tasks for finished picking orders (server-computed box
  counts: `boxCount` / `closedBoxCount`).
- Task detail as **one consolidated read** (`GET /measuring-tasks/:id`):
  the task, its picking order, and all shipping boxes with their packages
  (part identity embedded on each package).
- Per-box page (`/measuring/:taskId/box/:boxId`): verify packages by
  scanning labels — matching runs client-side against the box's packages,
  then `verifyPackage` by id.
- Record box measurements (box size, net/gross weights in integer grams,
  destination country) via the shared picking verbs
  (`updateShippingBox`), then close the box.
- Complete the measuring task once every box is closed and all items are
  fully packed.

## Out of scope

- Carrier rate shopping.
- Label printing for shipping boxes.
- Integration with scales or dimensioners.
- Multi-package shipment optimization.

## Key files

- `pages/measuring/index.vue` — task list.
- `pages/measuring/[id].vue` — task detail (boxes overview, complete
  action).
- `pages/measuring/[taskId]/box/[boxId].vue` — box page (package verify by
  scan, measurements, close).
- `components/BoxMeasurementsModal.vue` — measurement entry.
- `composables/useScanMatchers.ts` — client-side `matchMeasuring`
  (read-only match against the box's packages; apply calls
  `WarehouseService.verifyPackage`).
- `services/adapters/backendWarehouse.ts` — measuring reads reuse the
  picking verbs for box mutations.
- `apps/backend/src/routes/measuring.ts` + `apps/backend/src/db/measuring.ts` —
  `GET /measuring-tasks?status=`, `GET /measuring-tasks/:id`,
  `POST /measuring-tasks/:id/complete`. Box mutations live with picking
  (`/packages/:id/verify`, `PATCH /shipping-boxes/:id`,
  `/shipping-boxes/:id/close`).
- `apps/backend/src/db/picking.ts` — finishing a picking order (manual or
  auto when the last package is boxed) inserts the `measuring_tasks` row.

## Known limitations

- Measurements are typed manually; no real weight or dimension capture.
- Completing a task no longer spawns a separate pre-shipment verification
  task (the new backend has no `verification_tasks` table — goods verify is
  the daily lot-count queue instead).

## Related specs/plans

- `docs/backend/api-design.md` §Measuring
- `docs/superpowers/specs/2026-07-02-measuring-flow-design.md`
- `docs/superpowers/specs/2026-07-03-boxes-section-redesign-design.md`
- `docs/superpowers/plans/2026-07-12-picking-execution.md`
