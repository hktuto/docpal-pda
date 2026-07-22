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
5. Once all packages are verified, the operator records box size, net/gross weight, and destination country, then finishes the box.
6. When every box is closed, the operator completes the measuring task.

## Related guides

- [Step-by-step operator guide](./steps.md)
- [Box measurements](./box-measurements.md)
- [AI scope](./ai-scope.md)
