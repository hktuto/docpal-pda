# Stock-search lot batch edit (admin) — design

**Date:** 2026-11-19
**Function:** Admin `/stock-search` (ADM-034)
**Status:** Delivered

## Problem

Admins can fix wrong date codes / COO / COW / drawing numbers on receiving invoice
items (TOC 4.1 item edit), but once stock is put away the same wrong identity
values live on `inventory_lots` and there is no admin tool to fix them — the
only path was raw SQL.

## Solution

Add the receiving detail's edit UX to the admin stock-search lots table:

- **Row selection** on both table modes (server-paged ungrouped + client-side
  group tables): a leading checkbox column (`DataTable selectable` +
  `v-model:selected`, `getRowId: lot.lotId`), with a batch bar (selected
  count / Batch edit / Clear) above the tables, mirroring the receiving detail
  page. Selection clears on every new search.
- **Per-row edit** — a ✏️ button next to the 🕒 history button in the part-no
  cell opens the single-item edit modal.
- **Edit modal** — the receiving `components/receiving/ItemEditModal.vue`
  reused unchanged, with two new optional props `withLotCode` / `withCtnNo`
  (both default `true`; the lot edit passes `false` — lot code and carton no
  are not editable here) plus `withDrawingNo`. In batch mode only non-blank
  fields are applied (blanks leave each lot's value; tick the field's Clear
  box to erase it), single mode sends all fields (blank clears). The modal's
  Today / Next-week date-code buttons now generate the date in the flow's
  configured label format (`toLabelDateCode(dateToDateCode(d), format)`) —
  identical output to the old hand-rolled WWYY math under the default
  `wwyy` config and correct under `yyww`.

Fields editable on a lot: **dateCode, coo, cow, drawingNo** — all real columns
on `inventory_lots` (unlike receiving items, drawing no is not jsonb).

### Date-code format boundary

The page displays lots in the label format (`toLabelDateCode`), so the modal
pre-fills and accepts label-format codes; `saveLotEdit` converts back to
canonical YYWW via `toCanonicalDateCode` before posting.

## Backend

- `PATCH /admin/inventory-lots/:id` (`src/routes/admin/flowEdits.ts`) — body
  `{ dateCode?, coo?, cow?, drawingNo? }`, `null`/`""` clears, absent keys
  unchanged; 400 when no known field present.
- `updateInventoryLotFields` (`src/db/adminedits.ts`) — updates
  `inventory_lots` + one `transaction_logs` audit row per changed field
  (`entity_type: 'inventory_lot'`, metadata carries partNo / wclItemNo /
  field / from / to). A new identity colliding with another located lot
  (unique index `inventory_lots_unique_lot`) surfaces as **409
  duplicate_lot_identity**.

No allocation recompute is scheduled: allocations reference lots by id, so
identity edits don't detach them; the values are re-read at print/decode time.
Downstream processes (outdated warnings, label printing, scanning) simply read
the corrected values from the next load.

## Known limitations

- Server-paged (ungrouped) mode selects only the current page's rows — batch
  edit applies to lots on the fetched page; use group-by mode for a
  whole-result selection.
- Editing `inventory_lots` does not back-port to the receiving invoice items
  that sourced the lot (`inventory_lot_sources` keeps pointing at the item's
  original values); the receiving order history still shows what was received.
