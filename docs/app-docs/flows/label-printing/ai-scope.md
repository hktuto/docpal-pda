# Label Printing — AI Scope and Remarks

## In scope

- Label-printing queue list (`/label-printing`): picking orders with
  `status = 'picking_finished' AND label_printing_pending`, served by
  `GET /label-printing-orders?search=&limit=&offset=` → `{rows, total}` —
  a mirror of `GET /labeling-orders` (same scoping, search, 50-row paging,
  same row shape including the LIVE `labelMatches` per row). Page conventions
  follow the labeling list: `useVisibleReload(load,
  ["/label-printing-orders", "/picking-orders"])`, search box, 50-row
  load-more. List-row rendering comes from
  `pdaViewConfig.lists["label-printing"]` (chip catalog
  `status`/`allocation_status`/`working_by_name`/`labelCount`/`none`; default
  `{title:"[order_no]", meta:["[customer_code] · [ship_to]"], chip:"labelCount"}`).
- Queue entry is **snapshotted** at picking finish: `finishPickingOrder`
  (`apps/backend/src/db/picking.ts`) sets `picking_orders.label_printing_pending
  = true` (+ a `label_printing_pending` transition log with the matched
  internal rule ids) when the `label-printing` flow step is enabled AND the
  order matches ≥ 1 active **internal** `label_print_rules` row — internal
  only: external labels are customer-provided and never printed by us, so
  external-only orders skip this stage and enter labeling directly. Later rule
  edits do not move orders in/out of the queue. The finish response carries
  `labelPrintingPending` (winning over `labelingPending`) so the PDA routes to
  `/label-printing/[id]` after the immediate print prompt (see the picking
  flow; `resolvePickingFinishRoute` routes printing → labeling → verify →
  list).
- Label-printing detail (`/label-printing/[id]`): order header + the shared
  print panel (`components/picking/LabelPrintRulesPanel.vue`, same body as the
  labeling detail) + print-all. Live rule re-evaluation via
  `GET /picking-orders/:id/label-print-rules`; zero live matches → an info
  line ("rules no longer match") replaces the print rows; finishing stays
  available. The page bounces to the list when the detail comes back with
  `labelPrintingPending === false` (another operator or an admin override
  cleared the stage).
- **Finish printing** → `POST /picking-orders/:id/label-printing-finish`
  (`finishLabelPrinting`): 404 `picking_order_not_found`, 409
  `label_printing_not_pending` unless `picking_finished` + pending (the PDA
  treats that 409 as already-done — `finishLabelPrintingOrAlreadyDone` /
  `isLabelPrintingNotPending` in `apps/pda/utils/labeling.ts`); clears the
  flag, stamps `label_printing_done_at`/`label_printing_done_by`, logs
  `label_printing_done`. Progression: with the `labeling` step enabled the
  order enters labeling (`labeling_pending = true` + transition log —
  guaranteed by the finish-time snapshot even if rules were edited since);
  else `advanceAfterPickingFinish` runs (verify spawn / measuring gate
  release). Returns `{id, status, labelPrintingPending: false,
  labelingPending}` — the PDA navigates to `/labeling/[id]` when
  `labelingPending`, else back to `/label-printing`. Emits SSE
  `picking.label_printing_finished` (topics `["/picking-orders",
  "/label-printing-orders", "/labeling-orders"]`).
- Downstream gates while pending: `listMeasuringBoxes`
  (`apps/backend/src/db/measuring.ts`) and the verify-task spawn in
  `advanceAfterPickingFinish` both require `label_printing_pending = false`
  in addition to the labeling check.
- Flow step: `label-printing` in `FLOW_STEPS` (`apps/backend/src/config.ts`),
  default enabled, immediately before `labeling`. The PDA home tile is gated
  on `flowSteps["label-printing"]`; the step is edited like any other via
  `GET/PUT /admin/flow-config`. Disabling `label-printing` alone reproduces
  the single-stage labeling behavior; disabling `labeling` alone gives a
  print-only stage.
- Admin: flow-config step checkbox, pda-view-config `label-printing` list
  section, picking order detail read-only label-printing state line, and
  `label-printing` is an assignable flow on the task-assignments page
  (picking_orders entity, mirroring labeling). Any admin picking status
  override clears both `label_printing_pending` and `labeling_pending`
  (done_at/by kept as audit).

## Out of scope

- No new order status value — `status` stays `picking_finished` through the
  stage; `label_printing_pending` is orthogonal bookkeeping.
- No enforcement that anything was actually printed — finishing is an
  operator attestation.
- No pending-count badge on the home tile.
- External label rules never enter this queue (nothing to print); they are
  handled by the labeling stage.
- Reprinting after both stages are done lives on the picking detail page
  ("Print labels" header action), not here.

## Key files

- `apps/pda/pages/label-printing/index.vue` — the queue list.
- `apps/pda/pages/label-printing/[id].vue` — the label-printing detail (print
  panel + Finish printing action).
- `apps/pda/composables/useLabelPrintingOrders.ts` — list state (search +
  50-row paging over `GET /label-printing-orders`).
- `apps/pda/utils/labeling.ts` — `resolvePickingFinishRoute` (printing wins),
  `isLabelPrintingNotPending`, `finishLabelPrintingOrAlreadyDone`.
- `apps/pda/components/picking/LabelPrintRulesPanel.vue` — shared per-rule
  print rows (reused unchanged).
- `apps/pda/pages/index.vue` — home tile (`v-if="flowSteps['label-printing']"`).
- `apps/pda/composables/useFlowSteps.ts` — `"label-printing": true` default.
- `apps/pda/pages/picking/unified/[id].vue` + `apps/pda/pages/picking/[id].vue`
  — finish handlers pass `labelPrintingPending` into the route resolver.
- `apps/backend/src/routes/picking.ts` — `POST
  /picking-orders/:id/label-printing-finish`, `GET /label-printing-orders`.
- `apps/backend/src/db/picking.ts` — `finishPickingOrder` (sets the flag,
  returns `labelPrintingPending`), `finishLabelPrinting`,
  `listLabelPrintingOrders`, `getPickingOrderDetail` (`labelPrintingPending` /
  `labelPrintingDoneAt` / `labelPrintingDoneBy` / `labelPrintingDoneByName`).
- `apps/backend/src/config.ts` — `FLOW_STEPS` + `pdaViewConfig`
  `label-printing` list entry.
- `apps/admin/pages/flow-config.vue` (step checkbox),
  `apps/admin/pages/pda-view-config.vue` (list section),
  `apps/admin/pages/picking-orders/[id].vue` (state line),
  `apps/admin/pages/task-assignments.vue` (assignable flow).

## Known limitations

- The queue membership snapshot means deactivating a rule after finish does
  NOT unqueue the order — the operator marks it done (the detail page says
  the rules no longer match).
- SSE reload only; no push of live print-job state to the list.

## Related specs/plans

- `docs/superpowers/specs/2026-11-02-label-printing-step-design.md`
- `docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md`
- `docs/superpowers/specs/2026-10-30-label-source-and-label-verify-design.md`
- [Labeling AI scope](../labeling/ai-scope.md)
- [Picking AI scope](../picking/ai-scope.md)
