# Put-away skip-scan (select-and-shelve) design

Date: 2026-11-04
Status: implemented

## Problem

Put-away on the PDA requires scanning every supplier label before a piece can
be shelved. For orders where the operator can see the physical boxes match the
receiving paperwork (trusted supplier, full-carton put-away), per-label
scanning is pure friction. The operator wants to tick the parts on the order,
scan the target shelf once, and be done.

## Decision

Add a per-part-group checkbox on the put-away detail page
(`apps/pda/pages/put-away/[id].vue`, `PutAwayLotsPanel.vue`). Checking a group
means "the entire remaining qty of every member line of this part". Scanning a
shelf QR while any groups are checked puts the checked groups straight onto
that shelf — no label scans.

The feature is gated by a new flow-config knob
`steps["put-away"].skipScan` (boolean, default **false**) so each warehouse
opts in explicitly (multi-warehouse philosophy: differences are config, spec
2026-10-09).

## Why no backend write-path change

`recordPutAwayScan` (`apps/backend/src/db/putaway.ts`) already accepts a
`shelfCode` and performs the whole write in one transaction (scan row, lot
upsert, ledger, order-clear check). The "pending scan → commit to shelf"
two-step is only the UI's staging pattern. Skip-scan is therefore a pure PDA
change: one `recordPutAwayScan` call per member line with
`qty = remainingQty`, the scanned shelf, and the line's declared batch fields
(dateCode / lotCode / COO / COW), serial null.

CN mode needs even less: pieces stage locally anyway, so a shelf scan with a
selection stages the selected lines onto that shelf locally; the existing
batch-confirm button posts them.

## Trade-offs (accepted)

- **No physical-label verification.** Batch attributes come from the receiving
  line's declared values, not the label. If the box contents differ from the
  paperwork, the error lands in stock lots. Mitigated by: opt-in config knob,
  explicit per-group checkbox, and a confirm prompt naming the qty and shelf
  before any stock moves.
- **No serial numbers captured.** Skip-scan writes serial null; do not use it
  for serial-tracked parts.

## UX

- Each not-done group card gets a checkbox in the `AppListRow` `leading` slot
  (the slot exists for exactly this). Done groups render no checkbox.
- Checking several groups is allowed; one shelf scan shelves them all.
- Shelf-scan precedence in the hardware-scan handler: if any groups are
  checked, the shelf scan means "put the selection away here" (confirm prompt:
  total parts / pcs / shelf). If none are checked, behavior is unchanged
  (sticky shelf banner + pending-commit prompt).
- The selection is pruned on reload (groups that became done or disappeared
  drop out) and cleared after a successful commit.
- The normal scan flows (camera, gun, armed mode) are untouched and can be
  mixed with checkbox use on the same order.

## Config

`steps["put-away"].skipScan: true` in the flow config
(`warehouse_config` row `"flow"`, admin-editable via `/admin/flow-config`;
`FLOW_CONFIG` env still wins). Validated at boot; unknown-type values reject
like the other put-away keys. HK and SZ seed configs enable it; existing
databases keep the row they have, so the knob must be flipped via the admin
console (or a re-seed) there.

## Files

- Backend: `apps/backend/src/config.ts` (knob + validation + default),
  `apps/backend/src/db/seed.ts` (HK/SZ seed configs).
- Admin: `apps/admin/pages/flow-config.vue` (checkbox in the put-away
  section — required so an admin save doesn't silently drop the key from the
  fully-expanded steps JSON), `apps/admin/utils/flowApi.ts`.
- PDA: `apps/pda/services/types.ts`, `apps/pda/composables/useFlowSteps.ts`,
  `apps/pda/components/put-away/PutAwayLotsPanel.vue`,
  `apps/pda/pages/put-away/[id].vue`, `apps/pda/utils/putAwayGroups.ts`
  (selection helper), i18n in `layers/i18n/i18n/locales/`.
