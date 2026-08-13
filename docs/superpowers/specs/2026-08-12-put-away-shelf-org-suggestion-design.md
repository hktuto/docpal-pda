# Put-away shelf suggestion: shelf org affinity + same-part box hint

Date: 2026-08-12
Status: implemented
Builds on: `2026-08-10-put-away-tasks-design.md` (task mode + `suggestedShelfCode`)

## Problem

When a put-away task is created, the operator gets no guidance on WHERE to
put each item. The existing `suggestedShelfCode` ("existing-stock" strategy)
only helps when the exact part already has stock history in the task's
org + sub-inventory, and it names a shelf only — not the open box the item
could join.

## Design

### 1. Shelf sub-inventory affinity (`shelves.sub_inventory_codes`)

Nullable text-array column `sub_inventory_codes` on `shelves` (sub-inventory
codes — arrays can't FK, same as everywhere else).
`NULL`/empty = shared / any sub-inventory. **Advisory only**: it ranks
suggestions; put-away scans to any shelf remain allowed (the stock partition
is stamped from the box's org/sub-inventory pair, so a hard constraint would
add rejection paths without protecting anything).

Editable in the admin console's shelves CRUD as a multi-select of the known
sub-inventory codes (`GET /admin/sub-inventories`; CrudForm field type
`multiSelect`, payload string array, empty selection → NULL).

### 2. Extended per-item suggestion on the put-away aggregate

The suggestion lives on the shared aggregate (`GET
/receiving-orders/:id/put-away`, also returned by `GET /put-away-tasks/:id`),
so it shows in both candidate mode and task mode. Each item's suggestion
becomes three fields (all null when nothing matches or
`putAway.suggestShelf === "off"`):

- `suggestedShelfCode: string | null`
- `suggestedBoxId: string | null` — an OPEN shelf box containing the same
  part (matched on `part_no` only — NOT date code; the operator can put the
  item into that box)
- `suggestionReason: "same-part-box" | "same-part-stock" | "sub-inventory-shelf" | null`

Ranking (scoped to the order's `org_id` + `sub_inventory_code`):

1. **same-part-box** — most recently created open `shelf_boxes` row whose
   `shelf_box_items` contain the item's `part_no` → suggest that box's
   shelf + the box id.
2. **same-part-stock** — existing behavior: shelf of the most recent
   `inventory_lots` row for the part (any date code).
3. **sub-inventory-shelf** — first shelf (by code) whose
   `sub_inventory_codes` contain the order's sub-inventory. Fallback for
   parts with no stock history.
4. null.

Computed at read time like today, never stored. The `suggestShelf` config
gate (`"existing-stock" | "off"`) is unchanged — "existing-stock" now means
the full ranking above.

### 3. PDA display

`PutAwayLotsPanel.vue` shows the shelf hint as today; when `suggestedBoxId`
is present a second line names the box ("same part already in this box").
i18n keys under `putAway.lotsPanel.*` in all three locales.

## Non-goals

- No hard sub-inventory enforcement at scan time.
- No date-code matching for the box hint (explicitly relaxed by requester —
  part/WCL part no only).
- No shelf-capacity or zone-based logic.
