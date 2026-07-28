# Measuring Overview

Measuring is the process of recording shipping-box dimensions and packing items after a picking order is finished.

## When to use it

Use the Measuring flow when a picking order status becomes finished and a measuring task is created.

## Concept

1. The operator opens the Measuring list.

   ![Measuring list](./assets/measuring-list.png)
   *Measuring list (empty state when no tasks are ready)*

2. The operator selects a measuring task — the detail shows the picking order's shipping boxes with their verification progress.
3. The operator opens a box — tap **Open box**, or scan the box's QR code to jump straight in.
4. On the box page (a table of the box's packages) the operator scans each package's QR label to verify it; a per-row camera Scan button is the OCR fallback.
5. Once all packages are verified, the operator records box size, net/gross weight (kg — the net weight is pre-filled from the part net-weight master and can be adjusted), and destination country, then taps **Confirm box** — one action that saves and closes the box.
6. When the last box of the order is confirmed, the measuring task completes automatically (no separate complete step); when the verify step is enabled, a verify task is created for the order.

## Related guides

- [Step-by-step operator guide](./steps.md)
- [Box measurements](./box-measurements.md)
- [AI scope](./ai-scope.md)
