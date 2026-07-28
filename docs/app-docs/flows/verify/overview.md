# Verify Overview

Verify is a second check of the shipping boxes after measuring: another worker scans each box and re-scans every item in it, and can re-open boxes to correct measurements, before the order goes to shipping.

## When to use it

Use the Verify flow when a measuring task is completed and a verify task is created for the picking order (or, when the measuring step is disabled, as soon as a picking order is finished). The step can be turned off entirely via the backend `FLOW_STEPS_DISABLED` config — then completed measuring tasks go straight to shipping and the Verify tile is hidden.

## Concept

1. The operator opens the Verify list — pending verify tasks for finished picking orders.
2. The operator selects a verify task — the detail shows the order's shipping boxes with their re-scan progress and recorded measurements.
3. If a box needs correction, the operator taps **Reopen** on the closed box — the box opens and its packages must be re-scanned before it can be re-closed.
4. The operator opens a box — tap **Open box**, or scan the box's QR code to jump straight in.
5. On the box page (shared with measuring) the operator scans each package's QR label again to re-verify it — this works on closed boxes too (checking contents against the sealed box is the normal verify pass). Box size, weights (kg), and destination country can be edited on open boxes.
6. When every package of every box has been re-scanned and every box is closed, the operator completes the verify task — the order is now ready to ship.

## Related guides

- [Step-by-step operator guide](./steps.md)
- [Box measurements](../measuring/box-measurements.md)
- [AI scope](./ai-scope.md)
