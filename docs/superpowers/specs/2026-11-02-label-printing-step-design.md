# Label printing step （打印标签） — split from labeling — design

- Date: 2026-11-02
- Status: implementing
- Builds on: `2026-10-28-picking-labeling-step-design.md` (labeling stage), `2026-10-30-label-source-and-label-verify-design.md` (label source)

## Background

The labeling stage (2026-10-28) covers two different physical duties in one
step: **printing** the labels and **sticking** them on the goods. The CN
warehouse wants these as two consecutive PDA steps with separate task queues,
so one operator can print everything at the printer bench while another sticks
labels on the floor.

## Goal

Split the single `labeling` stage into two:

```
allocated → PDA picking → picking finish → [label printing?] → [labeling?] → measuring | verify → shipped
```

- **Label printing （打印标签）** — new flow step `label-printing`, new PDA
  list/detail, new `label_printing_pending` state. Applies only when ≥ 1
  **internal** rule matched (external labels are not printed by us).
- **Labeling （待贴标签）** — existing step, now entered after label printing
  is finished (or directly at picking finish when the printing stage does not
  apply). Applies when ≥ 1 rule of any source matched (external-only orders
  still enter labeling, unchanged decision from 2026-10-30).
- Both steps default **enabled** (same as `labeling` today). Disabling
  `label-printing` alone reproduces today's single-stage behavior; disabling
  `labeling` alone gives a print-only stage; disabling both removes the stage
  entirely.

## Order state

New nullable columns on `picking_orders` (migration via `db:generate`):

- `label_printing_pending` boolean NOT NULL DEFAULT false
- `label_printing_done_at` timestamptz NULL, `label_printing_done_by` text NULL

Existing `labeling_pending` / `labeling_done_at` / `labeling_done_by` keep
their meaning.

## Backend

### Flow config (`src/config.ts`)

- `FLOW_STEPS` gains `"label-printing"` immediately before `"labeling"`;
  default enabled.
- `PDA_VIEW_LIST_KEYS` gains `"label-printing"`; chip catalog = the labeling
  catalog (`["status","allocation_status","working_by_name","labelCount","none"]`);
  list default `{title: "[order_no]", meta: ["[customer_code] · [ship_to]"], chip: "labelCount"}`.

### `finishPickingOrder` (`src/db/picking.ts`)

After the status stamp, resolve matches once:

1. `isStepEnabled("label-printing")` AND ≥ 1 **internal** match → set
   `label_printing_pending = true`, log `label_printing_pending` transition
   (metadata: matched internal rule ids), skip `advanceAfterPickingFinish`,
   return `{labelPrintingPending: true, labelingPending: false}`.
2. Else `isStepEnabled("labeling")` AND ≥ 1 match (any source) → today's
   behavior: `labeling_pending = true`, `labeling_pending` transition log,
   skip advance, return `labelingPending: true`.
3. Else → unchanged (advance immediately), both flags false.

### `POST /picking-orders/:id/label-printing-finish` → `finishLabelPrinting`

Tx:

- 404 `picking_order_not_found`; 409 `label_printing_not_pending` unless
  `status = 'picking_finished' AND label_printing_pending` (PDA treats the 409
  as "already done", same convention as labeling).
- Clear the flag, stamp `label_printing_done_at/by`, log `label_printing_done`.
- Progression:
  - `isStepEnabled("labeling")` → set `labeling_pending = true`, log
    `labeling_pending` transition (metadata: live matched rule ids). Entry is
    guaranteed by the finish-time snapshot — the order had internal matches
    when printing became pending, so it enters labeling even if rules were
    edited since.
  - else → `advanceAfterPickingFinish`.
- Return `{id, status, labelPrintingPending: false, labelingPending}` so the
  PDA can route to the labeling detail.
- Emit SSE `picking.label_printing_finished`, topics `["/picking-orders",
  "/label-printing-orders", "/labeling-orders"]`.

### `finishLabeling` — unchanged (clears `labeling_pending`, advances).

### Gates extended with `label_printing_pending = false`

- `listMeasuringBoxes` (`src/db/measuring.ts`) — add
  `AND po2.label_printing_pending = false` alongside the labeling check.
- The verify-task spawn query in `advanceAfterPickingFinish` — same addition
  (cross-order box waits for the other order's printing stage too).

### Admin status override (`overridePickingOrderStatus`)

Clears both `label_printing_pending` and `labeling_pending` (done_at/by kept
as audit).

### Reads

- `GET /label-printing-orders` — mirror of `GET /labeling-orders` over
  `label_printing_pending` (same scoping, search, 50-row paging, live rule
  matches per row).
- `GET /picking-orders/:id` gains `labelPrintingPending`,
  `labelPrintingDoneAt`, `labelPrintingDoneBy`, `labelPrintingDoneByName`.

## PDA (`apps/pda`)

- `FlowStep` + `useFlowSteps` default gain `label-printing: true`; home tile
  "Label Printing / 打印标签 / 打印標籤" between Picking and Labeling.
- `/label-printing` list — mirror of `/labeling` (topics
  `["/label-printing-orders", "/picking-orders"]`, viewConfig key
  `label-printing`, labelCount chip).
- `/label-printing/[id]` detail — order header + `LabelPrintRulesPanel` +
  print-all (same body as the labeling detail) with footer **Finish printing**
  → `finishLabelPrinting` → route to `/labeling/[id]` when the response has
  `labelingPending`, else back to `/label-printing`. Bounces to the list when
  the order is not printing-pending.
- `/labeling/[id]` — unchanged (panel stays for reprints/external info;
  **Finish labeling** stays the attestation that labels are stuck).
- Picking finish handlers (`pages/picking/unified/[id].vue`,
  `pages/picking/[id].vue`): finish response gains `labelPrintingPending`;
  `resolvePickingFinishRoute` routes printing → labeling → verify → list in
  that priority. The immediate LabelPrintPrompt at finish is unchanged.
- `utils/labeling.ts` gains `finishLabelPrintingOrAlreadyDone` /
  `isLabelPrintingNotPending`; new `composables/useLabelPrintingOrders.ts`
  mirrors `useLabelingOrders.ts`; services/adapter gain
  `getLabelPrintingOrders` + `finishLabelPrinting`; `utils/viewConfig.ts`
  gains the `label-printing` list key (chip-field mapping reuses the picking
  fields and the shared `labelCount` chip label).

## i18n

New keys in all three locales (`en-US` / `zh-CN` / `zh-HK`):

- `meta.labelPrinting` / `meta.labelPrintingDetail`
- `home.menu.labelPrinting`: "Label Printing" / "打印标签" / "打印標籤"
- `labelPrinting.*`: title, searchPlaceholder, empty, totals, finish ("Finish
  printing" / "完成打印" / "完成打印"), confirmFinish, alreadyDone,
  noLongerMatch — mirroring the `labeling.*` block.
- error `label_printing_not_pending`; admin step label `label-printing`;
  admin picking-detail fields `labelPrintingPending` / `labelPrintingDone`.

## Admin console

- `pages/flow-config.vue` `STEPS` gains `"label-printing"` before `"labeling"`.
- `pages/pda-view-config.vue` gains the `label-printing` list section;
  `utils/viewConfig.ts` + `utils/listRowTemplate.ts` mirror the backend
  catalogs.
- `pages/picking-orders/[id].vue` — read-only label-printing state line next
  to the existing labeling line.
- `pages/task-assignments.vue` + backend `src/db/taskAssignments.ts` —
  `label-printing` becomes an assignable flow mirroring `labeling`
  (picking_orders entity).

## Edge cases

- **External-only order**: skips label printing (nothing to print), enters
  labeling directly at picking finish — same as today.
- **Rules edited mid-stage**: printing-pending orders stay queued (snapshot);
  finishing printing moves them to labeling even if rules no longer match;
  the labeling detail already handles "rules no longer match".
- **Labeling step disabled, printing enabled**: finishing printing advances
  the order directly (verify spawn / measuring gate release).
- **Admin override while either stage pending**: both flags cleared.
- **Orders finished before this ships**: both flags default false — never
  queued.

## Docs to update

`docs/backend/api-design.md`, `docs/backend/event-catalog.md`,
`docs/backend/schema-tables.md`, `docs/app-docs/flows/labeling/*` (+ new
`flows/label-printing/`), `ai/feature-registry.md`, `ai/code-map.md`,
`flows/index.md`.

## Testing

Manual verification by the owner; automated test updates deferred.
