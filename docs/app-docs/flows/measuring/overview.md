# Measuring Overview

Measuring is the process of verifying a shipping box's contents and recording its measurements (box size, weights) before closing it.

## When to use it

Use the Measuring flow once picking has packed items into shipping boxes **and the picking order is confirmed complete** (the operator tapped Complete Picking on the picking order). There is no measuring task: the list shows the open shipping boxes that contain packages, grouped by picking order, and closing a box *is* the measuring completion. Boxes whose picking is still in progress stay off the list.

## Concept

1. The operator opens the Measuring list.

   ![Measuring list](./assets/measuring-list.png)
   *Measuring list — open boxes of picking-completed orders, grouped by picking order (empty state when none are ready)*

2. The operator selects a box — the page shows the box's packages with their verification progress. A box may contain packages from several picking orders (cross-order packing) and then appears under each order's group once *all* those orders are picking-complete.
3. On the box page (a table of the box's packages) the operator scans each package's QR label to verify it; a per-row camera Scan button is the OCR fallback.
4. Once all packages are verified, the operator records box size and net/gross weight (kg — the net weight is pre-filled from the part net-weight master and can be adjusted), then taps **Confirm box** — one action that saves and closes the box.
5. Closing the box completes its measuring; when the verify step is enabled, a verify task is created for the box. (When the measuring step itself is turned off in the flow config, this whole flow is skipped — the picking finish creates the verify task on the still-open box, and completing the verify closes it.)

## Related guides

- [Step-by-step operator guide](./steps.md)
- [Box measurements](./box-measurements.md)
- [AI scope](./ai-scope.md)
