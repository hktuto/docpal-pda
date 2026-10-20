# Measuring work list = post-picking queue, grouped by picking order (2026-10-20)

## Problem

`GET /measuring-boxes` listed every **open** shipping box with ≥1 package,
whatever the state of its picking order. Operators doing measuring saw boxes
that were still being picked (or whose order was abandoned/finished long
ago), with no signal of what was actually ready to measure.

Separately, the picking order's **Finish** (complete-picking) action lived
only in the app-header overflow menu, so operators boxed everything and then
had to leave and re-enter the page to discover/press it.

## Decisions

1. **The measuring list is a post-picking queue.** A box appears only when
   **every** picking order it holds packages for is picking-complete —
   `picking_orders.status IN ('finished', 'shipped')` (the order's explicit
   Finish; `finishPickingOrder` is the only finisher since 2026-10-16).
   Implemented as a `NOT EXISTS` package→item→order lookup against
   non-completed orders in `listMeasuringBoxes`
   (`apps/backend/src/db/measuring.ts`). A box packed early (or holding a
   cross-order package of an unfinished order) simply stays off the list
   until the last related order is finished — no data migration, no close
   coupling between finishing and boxes.

2. **The list is grouped by picking order.** `GET /measuring-boxes` now
   returns `[{orderId, orderNo, boxes: [MeasuringBoxListRow]}]`, ordered by
   newest box first. A cross-order box appears under each of its orders'
   groups (it only becomes visible once all of them are complete anyway).
   The PDA measuring list page renders a group heading (`measuring.orderGroup`
   i18n key) per picking order; the hardware-scanner box lookup flattens the
   groups.

3. **Finish picking is a bottom-bar button only.** On the unified picking
   page (`/picking/unified/:id`, the page the picking list opens) the Finish
   action is removed from the header menu and rendered as a prominent button
   in the fixed bottom bar (`unified-footer`), shown the moment
   `allItemsFullyBoxed` flips true (every item's `pickedQty >= qty`, i.e.
   every item is picked into a box) — no leave-and-re-enter needed, since
   every boxing path already refetches the order. The legacy detail page
   (`/picking/:id`) keeps its sticky bottom footer and loses the duplicate
   header action. The finish semantics (`POST /picking-orders/:id/finish`,
   409 `unresolved_outdated_warnings`) are unchanged.

## Non-goals

- No automatic box close on order finish (weights don't exist yet — closing
  still needs the measuring pass).
- No admin "orphaned boxes" view (boxes of unfinished orders are simply
  invisible to measuring; they surface once their orders finish).
- `GET /measuring-boxes/:id` is unchanged.
