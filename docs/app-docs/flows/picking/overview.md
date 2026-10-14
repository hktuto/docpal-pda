# Picking Overview

Picking is the process of removing items from inventory to fulfill outgoing picking orders.

## When to use it

Use the Picking flow when a picking order is ready and stock has been allocated.

## Concept

1. The operator opens the Picking list. Only confirmed work appears here —
   orders an admin has marked `allocated`, plus orders already `picking`;
   `finished` orders show when ticked in the filter (pending/skipped/issue/
   shipped orders are managed in the admin console).

   ![Picking list](./assets/picking-list.png)

2. The operator selects a picking order. The order opens on the **unified
   picking page** — one screen that combines the order detail and the scan
   session. (This page is new and under evaluation: the older detail and scan
   pages are still reachable at `/picking/:id` and `/picking/scan/:id` until
   it replaces them.)

   ![Picking detail](./assets/picking-detail.png)
3. The page shows the order's parts as a single list. Each collapsed row
   carries the part name with its progress inline — scanned / required
   quantity, any queued-but-unconfirmed scans, and where the remaining stock
   is allocated from (lot or receiving area). Tapping a row expands it to
   show the queued scans, box assignment for each package, the line breakdown
   and the planned allocations. The order's boxes are listed below the item
   list.
4. The operator picks each line by scanning — the sticky footer holds the
   OCR/camera button and the **Confirm** button that applies the queued scans
   — or by expanding a row and assigning packages to boxes by hand.
5. Optional: the operator can scan a supplier label to auto-match and apply a pick (OCR-assisted picking).
6. When all lines are picked, the picking order is finished — the packed boxes move on to measuring.

**Outdated date-code warnings:** if a scanned label's date code is older than the supplier's outdated limit (set per supplier in the admin console), the scan still succeeds but the app shows an alert and flags the order with a warning chip. The order cannot finish (auto-finish is held and the manual **Finish** action is refused) until an admin resolves the order's warnings in the admin console.

## Related guides

- [Step-by-step operator guide](./steps.md)
- [Label scan / OCR-assisted picking](./label-scan.md)
- [Issue reporting](./issue-reporting.md)
- [AI scope](./ai-scope.md)
