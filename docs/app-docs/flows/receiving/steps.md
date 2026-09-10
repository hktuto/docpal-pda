# Receiving Steps

## 1. Open the receiving list

From the home screen, tap **Receiving**. The list shows receiving orders as compact rows with status and a pending picking-order count badge; the status filters and search bar stay pinned at the top while scrolling. The list loads 50 orders at a time — tap **Load more** at the bottom for the next page, or the refresh button to reload. Search and filters apply to all orders, not just the loaded ones.

![Receiving list](./assets/receiving-list.png)

## 2. Select a receiving order

Tap the order you want to receive. The detail page opens on the Receiving view.

![Receiving detail](./assets/receiving-detail.png)

## 3. Review invoices and items

The detail shows each invoice and its line items as compact rows. When the invoice carries carton numbers, items are grouped under a carton (`ctnNo`) header with a trailing **No carton** group for the rest; otherwise the rows are flat. Tap a row to expand its quantities (expected / reserved / picked / put away / available, date/lot/COO/COW) and its actions — mismatch report, confirm, and cancel live inside the expanded row.

## 4. Confirm or adjust quantities

- If the physical quantity matches, confirm the line.
- If the quantity differs, report a mismatch. See [Mismatch handling](./mismatch-handling.md).

## 5. Create receiving-area inventory

Confirmed items become receiving-area inventory lots that can be picked or put away. If the warehouse configures sub-inventory rules (Admin → Flow Config), each item's sub-inventory is assigned automatically at this point from its org and PO number, so the stock can match picking demand right away.

## 6. Switch to Picking view (optional)

Tap **Picking** to see linked picking orders and use OCR-assisted picking to consume receiving-area stock directly.

## Scanning labels (optional)

Tap the floating camera button to scan a supplier label instead of confirming lines manually:

- A label that matches exactly one item applies immediately.
- An ambiguous or unknown label opens the candidate review dialog — pick the
  invoice line and quantity to receive.

  ![Scan review](./assets/receiving-scan-review.png)

- A **carton label listing several items** opens the multi-item table: one
  editable row per item (part + quantity). Apply receives every row; failed
  rows stay editable for a retry.

  ![Multi-item scan review](./assets/receiving-scan-multi-item.png)
