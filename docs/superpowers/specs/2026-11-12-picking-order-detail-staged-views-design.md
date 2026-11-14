# Picking order detail — staged views + progress header

Date: 2026-11-12
Scope: `apps/admin` (`pages/picking-orders/[id].vue`, `components/picking-orders/`)

## Problem

The picking-order detail page shows every section (info grid, issue panel, items, boxes,
audit log) plus every status-specific action regardless of the order's status — a pending
order drowns in shipping-boxes/verify UI, a shipped order still offers allocation actions.

## Design

Two pieces:

1. **Progress header** (`PickingOrdersOrderProgressHeader.vue`) — a horizontal stage
   pipeline at the top of the detail page:

   `allocate → picking → [print labels] → [apply labels] → [measure/verify] → ship`

   - Stage list is filtered by the warehouse **flow config** (`GET /config` `flowSteps`,
     mirrored by `useFlowSteps`): label-printing / labeling / measuring+verify stages are
     hidden when their steps are disabled.
   - Stage state derived from `order.status` (+ `labelPrintingPending` / `labelingPending`
     for the in-between stages): done ✓ / current (highlighted) / future.
   - `issue` / `cancelled` / `skip` orders show the bar dimmed with an alert badge.

2. **Status-driven body views** — the page maps status → body view
   (`viewForStatus` in the page script) and renders it below the header. Planned views:

   | status | view (planned) | focus |
   |---|---|---|
   | `pending` | AllocationView | items to allocate, availability, Re-allocate, Confirm allocation |
   | `allocated` | AllocationReviewView | allocation status, adjust/remove, confirm |
   | `picking` / `picking_finished` / `measuring_finished` | ProgressView | picking process, packages, boxes, labeling/printing state |
   | `shipped` | SummaryView | final summary |
   | `issue` | current issue panel + progress | resolve |

   **Current step ("1 view for all")**: every status renders the placeholder
   `OrderDetailView.vue` (the previous monolithic body, extracted unchanged). Per-stage
   views are carved out of it later by adding entries to the page's `stageViews` map.

## Responsibility split

- Page `[id].vue`: order load + SSE change notice (`useChangeNotice`), page-head global
  actions (download picking list, print PNG, override status, reset, back), override &
  print dialogs, progress header wiring, status→view switch.
- Body view (`OrderDetailView.vue`): owns everything stage-specific — stage action buttons
  (Re-allocate / Report issue / Confirm allocation), info grid + save, assignee pickers,
  issue panel, items/boxes tables, availability & report modals, audit-log table. Mutations
  call the injected `refresh()` prop (reload + audit-log bump). It exposes `changeBusy`
  so the page's SSE notice skips a silent reload while a body modal is open.

## i18n

`admin.pages.pickingOrders.progress.{allocate,picking,labelPrinting,labeling,verify,ship}`
in all three locales.
