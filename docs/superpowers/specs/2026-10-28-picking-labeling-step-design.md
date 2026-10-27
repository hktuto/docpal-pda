# Picking labeling step （待贴标签） — design

- Date: 2026-10-28
- Status: implemented (2026-10-28) — open questions resolved: keep the immediate finish-time print prompt (queue is the print-later path), no home-tile pending-count badge, any operator may finish labeling.
- Builds on: `2026-10-27-picking-finish-label-print-prompt-design.md` (label print rules + prompt), `2026-10-27` measuring-off → verify chain change

## Background

Today the picking chain is:

```
picking order (allocated) → PDA picking → picking finish
  → measuring (box close) → verify (re-scan) → shipped
```

The 2026-10-27 change added a label-print **prompt** right at picking finish
when the order matches a `label_print_rules` row — but printing there is
optional and leaves no trace: an operator who skips it has no queue telling
them the order still needs labels, and nothing stops the order from flowing
straight into measuring/verify unlabeled.

## Goal

Insert a formal **labeling** stage between picking finish and
measuring/verify:

```
allocated → PDA picking → picking finish → [labeling?] → measuring | verify → shipped
```

- When a picking order finishes and matches ≥ 1 active label print rule, the
  order enters the labeling stage: it appears in a new PDA **Labeling
  （待贴标签）** task list and its boxes are **held back** from measuring and
  verify.
- The operator opens the order from the labeling list, prints the label(s)
  (multiple rules/templates, re-printable — same UI as the finish prompt),
  then explicitly marks **labeling finished**.
- Only then does the order's boxes become eligible for measuring (step on) or
  get their verify tasks spawned (measuring off, verify on — the 2026-10-27
  chain).
- Orders matching no rule skip the stage entirely (today's behavior).

## Non-goals

- No new order status value: `picking_orders.status` stays
  `picking_finished` through the labeling stage (see "Order state" below).
- No per-box labeling state: labeling is per-order (labels come from order-
  level rules); cross-order boxes wait for ALL their orders to clear
  labeling, mirroring the existing "all orders picking-complete" gate.
- No enforcement that anything was actually printed: marking labeling done is
  an explicit operator attestation, same as the skip path today.
- Admin label-print-rule CRUD is unchanged.

## Order state

New nullable columns on `picking_orders` (migration via `db:generate`):

- `labeling_pending` boolean NOT NULL DEFAULT false — set at picking finish
  when the labeling stage applies (see below); cleared by labeling finish or
  an admin status override.
- `labeling_done_at` timestamptz NULL, `labeling_done_by` text NULL — audit
  of who cleared the stage.

`status` keeps flowing `picking_finished → measuring_finished → shipped` as
today; `labeling_pending` is orthogonal bookkeeping on top of
`picking_finished`. This avoids touching the admin status-override matrix,
the measuring/verify status gates, and every `status IN (...)` query.

**Stage applies when:** the `labeling` flow step is enabled AND
`resolveLabelPrintRulesForOrder` (labelPrint.ts, first-match-per-label-type)
returns ≥ 1 match at finish time. The match result is **snapshotted** into
`labeling_pending` at finish — later rule edits do not move orders in/out of
the queue. (The labeling detail page re-evaluates rules live for the print
list; if the rules no longer match, the page says so and the operator just
marks done.)

## Backend

### Flow config

- New step key `labeling` in `FLOW_STEPS` (`src/config.ts`), default
  **enabled** (with zero rules configured nothing changes — no order ever
  enters the stage). Editable via `GET/PUT /admin/flow-config` like any
  other step; validated by the existing steps whitelist.
- `isStepEnabled("labeling")` gates the stage everywhere below.

### `finishPickingOrder` (`src/db/picking.ts`)

After the existing status stamp + log:

1. If `isStepEnabled("labeling")` and `resolveLabelPrintRulesForOrder(tx,
   order.id)` is non-empty → set `labeling_pending = true`, log a
   `labeling_pending` transition (metadata: matched rule ids), and **skip**
   the measuring-off verify-task spawn (deferred to labeling finish).
2. Else → unchanged (verify-task spawn for measuring-off runs immediately).

Return value gains `labelingPending: boolean` so the PDA finish handler
knows where to route the operator.

### `POST /picking-orders/:id/labeling-finish` (`src/routes/picking.ts` → `src/db/picking.ts finishLabeling`)

Tx:

- 404 `picking_order_not_found`; 409 `labeling_not_pending` unless
  `status = 'picking_finished' AND labeling_pending`.
- Clear `labeling_pending`, stamp `labeling_done_at/by`, log transition.
- Run the deferred progression — extracted shared helper
  `advanceAfterLabeling(tx, order)`:
  - measuring on → nothing to spawn (the box surfaces in
    `listMeasuringBoxes` once the gate below clears);
  - measuring off + verify on → the verify-task spawn block moved verbatim
    out of `finishPickingOrder`, with its cross-order gate extended (below).
- Emit SSE `picking.labeling_finished`, topics `["/picking-orders",
  "/labeling-orders"]`.

Idempotent-friendly: a second call 409s; the PDA treats 409
`labeling_not_pending` as "already done" and moves on.

### Gates extended with `labeling_pending = false`

Both gates currently read "every order in the box is
picking_finished/measuring_finished/shipped":

- `listMeasuringBoxes` (`src/db/measuring.ts`) — add
  `AND po2.labeling_pending = false` to the NOT EXISTS (a labeling-pending
  order keeps its boxes out of the measuring queue).
- The verify-task spawn query (shared helper above) — same addition (a
  cross-order box's verify task waits for the other order's labeling too).

`verifyPackage` / `completeVerifyTask` need no change: they key off the
verify_tasks rows / box status, which simply don't exist yet while labeling
is pending.

### Admin status override (`src/routes/admin/flowEdits.ts`)

Any picking status override clears `labeling_pending` (keeps
`labeling_done_at/by` as historical audit). Rationale: the override is the
admin force-move escape hatch; an order jumped to `shipped` must not linger
in the labeling queue, and one moved back to `picking` gets re-evaluated at
its next finish.

### Labeling queue read

`GET /labeling-orders` (`src/routes/picking.ts` or a small
`src/routes/labeling.ts`): rows = `status = 'picking_finished' AND
labeling_pending`, org-scoped via the existing `pickingOrderOrgFilter`
(invoice/tn split + user scope), ordered `last_update_date DESC`. Row
shape: order id, order no, type, customer, ship_to, delivery date, item/total
qty counts (same aggregates as `listPickingOrders`), plus the **live** rule
matches (name + labelType + printTemplateId) resolved per row so the list
can show "2 labels" chips. Pagination: same 50-row load-more convention as
the picking list.

`GET /picking-orders/:id` gains `labelingPending`, `labelingDoneAt`,
`labelingDoneBy` (+ display name) so both the PDA labeling detail and the
admin console can render the state.

## PDA (`apps/pda`)

### Flow step + home

- `FlowStep` type + `useFlowSteps` defaults gain `labeling: true`.
- Home tile "Labeling / 待贴标签" between Picking and Measuring
  (`pages/index.vue`), `v-if="flowSteps.labeling"`.

### Labeling list page `/labeling`

Follows the picking list conventions: `useVisibleReload(load,
["/labeling-orders", "/picking-orders"])`, search box, 50-row load-more.
Each row: order no (title), customer/ship-to/delivery meta, chip with the
matched label count/types (from the row's live matches). Row tap →
`/labeling/[id]`.

### Labeling detail page `/labeling/[id]`

- Header: order no, customer, ship to, status chip.
- Body: the print UI **reused from `components/picking/LabelPrintPrompt.vue`**
  — refactored so the per-rule rows (Print with job polling, errors as
  toast) live in an embeddable `components/picking/LabelPrintRulesPanel.vue`
  used by both the finish-prompt modal and this page (no behavior fork).
  Data comes from the existing `GET /picking-orders/:id/label-print-rules` +
  `utils/labelPrintParams.ts` + `utils/print.ts`.
- If the live re-evaluation returns zero matches (rules edited since
  finish): show an info line "rules no longer match" in place of the print
  rows; the finish action stays available.
- Footer action: **Finish labeling** (confirm dialog) →
  `finishLabeling(orderId)` → toast → navigate to `/labeling` (list
  refreshes; the order is gone).
- Reprint stays possible after labeling is done via the existing "Print
  labels" action on the picking detail page.

### Picking finish wiring (adjusts the 2026-10-27 prompt flow)

`pages/picking/unified/[id].vue` + `pages/picking/[id].vue` finish handlers:

- Finish response now carries `labelingPending`.
- `labelingPending = true` → keep the immediate LabelPrintPrompt (print
  now), and on prompt close navigate to `/labeling/[id]` (operator
  continues printing there or marks done) instead of the measuring-off
  `/verify` jump — the verify chain is held by the backend anyway.
- `labelingPending = false` → exactly today's routing (measuring-off →
  `/verify`, else back to list).

### pdaViewConfig

- `pdaViewConfig.lists` gains a `labeling` entry (`{title, meta[1–2], chip}`)
  with its own chip catalog (`labelCount`, plus the shared order fields),
  validated in `src/config.ts` against the per-list catalogs and resolved
  onto `GET /config` like the other six lists. Legacy `pdaListTemplates`
  untouched (labeling never had one).

## i18n

New keys in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`:

- `home.menu.labeling.title`: "Labeling" / "待贴标签" / "待貼標籤"
- `labeling.*`: list title/empty state, detail headings, "Finish labeling"
  / "Mark as labeled", confirm copy, "rules no longer match" notice, print
  errors reuse `picking.printLabels.*`.

## Admin console

- Flow-config page: `labeling` checkbox appears via the existing steps
  enumeration (verify it iterates `FLOW_STEPS` rather than a hardcoded list;
  add the label otherwise).
- Picking order detail: read-only labeling state line (pending since finish
  / done at/by) next to the status — no new admin actions (status override
  already clears it).

## Edge cases

- **Cross-order box**: waits for every member order to clear labeling before
  entering measuring / getting its verify task — consistent with the
  existing all-orders-picking-complete gate.
- **Both measuring and verify off**: nothing spawns after labeling either;
  the queue is then purely a print-checklist, still useful.
- **Labeling step disabled**: zero behavior change — `finishPickingOrder`
  never sets the flag; the immediate print prompt (2026-10-27) still works
  off the live rule evaluation.
- **Rule deactivated after finish**: order stays queued (snapshot), detail
  shows "rules no longer match", operator marks done.
- **Orders finished before this ships**: `labeling_pending` defaults false —
  never queued.
- **Admin override to `shipped` while pending**: flag cleared, box gates
  release, verify spawn skipped (order already terminal) — same as
  overriding any `picking_finished` order today.

## Tests

Backend (`src/db/picking.test.ts` or new `labeling.test.ts`):

- finish with matching rule + step on → `labeling_pending`, no verify task
  (measuring off), box absent from `listMeasuringBoxes` (measuring on).
- finish with no rule / step off → flag false, today's behavior intact.
- `finishLabeling`: happy path spawns the deferred verify task / releases
  the measuring gate; 409 when not pending; cross-order box waits for the
  second order's labeling.
- status override clears the flag.
- `GET /labeling-orders` scoping + row shape.

PDA (vitest): finish-handler routing on `labelingPending`; labeling list
render + load-more; detail finish action; panel reuse in both modal and
page.

## Docs to update

`docs/backend/api-design.md` (new endpoints), `docs/backend/event-catalog.md`
(new SSE event), `docs/backend/schema-tables.md` (new columns), `AGENTS.md`
(flow chain + step key), `docs/app-docs/flows/picking/*` +
`flows/verify/*` + `flows/measuring/*`, new `docs/app-docs/flows/labeling/`,
`ai/feature-registry.md`, `ai/code-map.md`.

## Open questions

1. **Immediate prompt vs. queue-only.** Keep the 2026-10-27 print prompt at
   picking finish (print now) with the queue as the print-later path
   (recommended — no regression to the just-shipped behavior), or drop the
   prompt and always route to the labeling page?
2. **Tile badge**: should the home Labeling tile show a pending-count badge
   (needs a count endpoint or piggyback on the list call)? Default: no
   badge in v1, plain tile.
3. **Who may finish labeling**: any operator, or only the order's
   `working_by` holder? Default: any operator (work lock is released at
   picking finish; labeling is a shared packing-bench task).

**Resolved at implementation (2026-10-28):** 1 → keep the immediate prompt
(with the queue as the print-later path); 2 → no tile badge; 3 → any operator
may finish.
