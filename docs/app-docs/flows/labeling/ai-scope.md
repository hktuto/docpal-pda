# Labeling — AI Scope and Remarks

## In scope

- Labeling queue list (`/labeling`): picking orders with
  `status = 'picking_finished' AND labeling_pending`, served by
  `GET /labeling-orders?search=&limit=&offset=` → `{rows, total}`
  (org-scoped + per-user sub-inventory scope like the picking list, ordered
  `last_update_date` DESC; rows carry the picking-list aggregates plus
  `labelMatches` = the LIVE `resolveLabelPrintRulesForOrder` result per row).
  Page conventions follow the picking list: `useVisibleReload(load,
  ["/labeling-orders", "/picking-orders"])`, search box, 50-row load-more.
  List-row rendering comes from `pdaViewConfig.lists.labeling` (chip catalog
  `status`/`allocation_status`/`working_by_name`/`labelCount`/`none`; default
  `{title:"[order_no]", meta:["[customer_code] · [ship_to]"], chip:"labelCount"}`).
- Queue entry is **snapshotted** at picking finish: `finishPickingOrder`
  (`apps/backend/src/db/picking.ts`) sets `picking_orders.labeling_pending =
  true` (+ a `labeling_pending` transition log with the matched rule ids)
  when the `labeling` flow step is enabled AND the order matches ≥ 1 active
  `label_print_rules` row (first match per label type). Later rule edits do
  not move orders in/out of the queue. The finish response carries
  `labelingPending` so the PDA routes to `/labeling/[id]` after the immediate
  print prompt instead of `/verify` (see the picking flow).
- Labeling detail (`/labeling/[id]`): order header + the print UI reused from
  the picking-finish prompt — the per-rule rows (Print with job polling,
  errors as toasts) live in the shared
  `components/picking/LabelPrintRulesPanel.vue`, embedded by both
  `components/picking/LabelPrintPrompt.vue` and this page. Data:
  `GET /picking-orders/:id/label-print-rules` (each match carries the
  backend-computed `labelCount`) + `POST /picking-orders/:id/label-print`
  (backend-side param conversion, spec 2026-10-29) + job polling via
  `utils/print.ts`. Zero live matches → an info
  line ("rules no longer match") replaces the print rows; finishing stays
  available.
- **Finish labeling** → `POST /picking-orders/:id/labeling-finish`
  (`finishLabeling`): 404 `picking_order_not_found`, 409
  `labeling_not_pending` unless `picking_finished` + pending (the PDA treats
  that 409 as already-done); clears the flag, stamps
  `labeling_done_at`/`labeling_done_by`, logs `labeling_done`, runs the
  deferred post-finish progression (the shared `advanceAfterPickingFinish`
  helper — the measuring-off verify-task spawn) and emits SSE
  `picking.labeling_finished` (topics `["/picking-orders",
  "/labeling-orders"]`).
- Downstream gates while pending: `listMeasuringBoxes`
  (`apps/backend/src/db/measuring.ts`) and the verify-task spawn both require
  `labeling_pending = false` for EVERY order in the box — a cross-order box
  waits for all its orders to clear labeling, mirroring the
  all-orders-picking-complete gate.
- Flow step: `labeling` in `FLOW_STEPS` (`apps/backend/src/config.ts`),
  default enabled (with zero rules configured nothing changes). The PDA home
  tile is gated on `flowSteps.labeling`; the step is edited like any other
  via `GET/PUT /admin/flow-config`.
- Admin: picking order detail shows a read-only labeling state line; any
  admin picking status override clears `labeling_pending` (keeps
  `labeling_done_at/by` as audit).

## Out of scope

- No new order status value — `status` stays `picking_finished` through the
  stage; `labeling_pending` is orthogonal bookkeeping.
- No per-box labeling state — labeling is per-order.
- No enforcement that anything was actually printed — finishing is an
  operator attestation.
- No pending-count badge on the home tile (v1).
- Label print rule CRUD is unchanged (admin `/label-print-rules`).
- Reprinting after the stage is done lives on the picking detail page
  ("Print labels" header action), not here.

## Key files

- `apps/pda/pages/labeling/index.vue` — the queue list.
- `apps/pda/pages/labeling/[id].vue` — the labeling detail (print panel +
  Finish labeling action).
- `apps/pda/components/picking/LabelPrintRulesPanel.vue` — shared per-rule
  print rows + the printer dropdown (agent printers, `label_printer`
  localStorage, empty = template default; used by both).
- `apps/pda/pages/index.vue` — home tile (`v-if="flowSteps.labeling"`).
- `apps/pda/composables/useFlowSteps.ts` — `labeling: true` default.
- `apps/backend/src/routes/picking.ts` — `POST
  /picking-orders/:id/labeling-finish`, `GET /labeling-orders`.
- `apps/backend/src/db/picking.ts` — `finishPickingOrder` (sets the flag,
  defers the spawn, returns `labelingPending`), `finishLabeling`,
  `listLabelingOrders`, `advanceAfterPickingFinish` (shared deferred
  progression), `getPickingOrderDetail` (`labelingPending` /
  `labelingDoneAt` / `labelingDoneBy` / `labelingDoneByName`).
- `apps/backend/src/db/measuring.ts` — `listMeasuringBoxes` labeling gate.
- `apps/backend/src/routes/admin/flowEdits.ts` — status override clears the
  flag.
- `apps/backend/src/config.ts` — `FLOW_STEPS` + `pdaViewConfig` `labeling`
  list entry.

## Known limitations

- The queue membership snapshot means deactivating a rule after finish does
  NOT unqueue the order — the operator marks it done (the detail page says
  the rules no longer match).
- SSE reload only; no push of live print-job state to the list.

## Related specs/plans

- `docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md`
- `docs/superpowers/plans/2026-10-28-picking-labeling-step.md`
- `docs/superpowers/specs/2026-10-27-picking-finish-label-print-prompt-design.md`
- `docs/superpowers/specs/2026-09-16-label-print-rules-design.md`
- `docs/backend/api-design.md` §Picking
- [Picking AI scope](../picking/ai-scope.md)
- [Measuring AI scope](../measuring/ai-scope.md)
- [Verify AI scope](../verify/ai-scope.md)
