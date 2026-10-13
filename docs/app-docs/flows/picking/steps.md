# Picking Steps

## 1. Open the picking list

From the home screen, tap **Picking**. The list shows the picking orders released for work — those confirmed by the office (`allocated`) plus orders already being picked or finished — as compact rows with status and summary information; the search bar and filter button stay pinned at the top while scrolling. The list is grouped into sections by status — **Picking** (in progress) first, then **Allocated** (ready to pick), then **Finished** — each with a count badge, and all matching orders are fetched at once (no paging). Tap the refresh button to reload. Search and filters apply to all orders.

![Picking list](./assets/picking-list.png)

## 2. Select a picking order

Tap the order you want to work on. The **unified picking page** opens — one screen that combines the order detail and the scan session (new page, under evaluation: the older detail and scan pages still exist at `/picking/:id` and `/picking/scan/:id` until it replaces them). The order number and status badge show in the app header; the horizontal-dots menu at the top right holds the order details (customer, delivery date, PO, ship-to, …) and the **Finish picking** action. Everything — reviewing lines, scanning, boxing, confirming — happens on this page; there is no separate scan page to open.

Opening an order locks it to you: while your page is open, the system will not re-shuffle that order's allocations. The lock releases when you leave the page (or expires after 10 minutes if the app is closed). If a banner says the order is "being picked by" a coworker, the page is read-only — pick a different order or ask them to leave it.

The list order is the priority order set by the office — work from the top.

![Picking detail](./assets/picking-detail.png)

## 3. Review the item list

The page lists the order's parts as one row per part number — order lines sharing a part are always merged into one row (totals across the lines; there is no merge toggle). A collapsed row shows the part name on the first line and the progress on the second line: how much is picked out of what is required (`2K/3K`), any scanned-but-not-yet-confirmed quantity (`+1K pending`), and one chip per source the remaining stock comes from — e.g. `3K(1K SZA01-2626-CN-CN, 2K SZB02A-2631-CN)` for stock lots, `CTN C3001` for a receiving carton, or a receiving-area label. Which fields appear on this line is admin-configurable. A fully picked row greys out.

Tap a row to expand it. From top to bottom the expanded row shows:

- **Pending scans** — every scan queued on this part but not yet confirmed, each with a **Remove** button; a scan that failed stays listed with its error message.
- **Line breakdown** (merged rows only) — the required and scanned quantity of each contributing order line.
- **Unboxed packages** — each picked-but-unpacked package with a box selector and **Add to box**.
- **Boxed packages** — each packed package with its box id and a **Remove** button (while that box is still open).
- **Planned allocations** (behind a collapsible summary, shown while the part is not fully picked) — where the remaining stock is allocated from: location, batch (date / lot / COO / COW) and allocated quantity. For allocations against a receiving order the recorded box id appears with the source so you know which boxes to pick from. If the allocated shelf carries a warning (set by an admin on the shelf, e.g. outdated-stock shelves), a ⚠️ icon appears next to the shelf code — hover/long-press shows the warning text; the stock is still pickable.

The order's boxes are listed in the **Boxes** section below the item list.

## 4. Pick each line

The hardware scanner is live whenever the order is open — aim and scan. The **OCR / camera** button in the sticky footer at the bottom captures a label photo instead (a single-record label opens the usual confirm form with candidate chips; a label whose table lists several parts opens the multi-row table). Scans are **queued first, not sent**: each successful part-label scan adds a row to that part's **Pending scans** list, the collapsed line updates (`+N pending`), and the **Confirm** button in the footer shows how many scans are waiting. Tap **Confirm** to send them:

- The picked quantity is recorded and the allocation is reduced or removed.
- The app re-resolves what is still left to pick after each confirm — the office's allocations may shift between scans.
- A scan that fails at confirm time stays listed on the part's expanded row with its error message — **Remove** it (or fix the cause) and confirm the rest.

### Whole-box shortcut

When everything the order still needs is exactly the contents of one shelf box, a green banner appears at the top of the page naming that box. Tap **Use whole box**, confirm, and the box is claimed as-is: it becomes the order's shipping box with everything already packed (its received size and weights are pre-filled), and the order finishes automatically — no item-by-item scanning. If no banner shows, pick the lines normally.

### Box / shelf / carton barcode scanning

Each item row shows where its remaining qty is allocated from (the collapsed line's chips, e.g. `CTN C3001`, and the expanded **Planned allocations**, e.g. `BOX-H-20260701-0003 @ A-02-01`) — go to that location and scan its barcode. When the order has several lines of the same part, they appear as one merged row (totals across the lines), and a scanned package may span those lines: a label qty that exceeds one line but fits the part's total is split across the lines automatically.

**Receiving carton** (known, sealed contents): scanning the carton barcode queues everything the order still needs from that carton in one go — no per-part scans. Re-scanning the same carton is rejected as a duplicate.

**Shelf box / shelf code** (loose stock): a **Pick from box** dialog opens listing what the order still needs from that box/shelf. Keep scanning the part labels inside the box — each scan queues that item against the box's allocation (a part that isn't in the box, or a label qty beyond what the box still needs, is rejected with a message). Scanning another box/shelf barcode switches the dialog to it.

**Shelf scan required first:** when the warehouse is configured to require a shelf scan before picking, a banner at the top of the page shows the current location — scan the shelf/box barcode to set it (it stays until you scan another one or tap clear) and part-label scans are rejected until it is set.

Apply the queued scans with **Confirm** as usual.

**Outdated date code alert:** if a scanned label's date code is older than the supplier's outdated limit, the scan still applies but an alert pops up naming the supplier, the date code and the limit, and the order gets a warning chip on the list and detail pages. Keep working — an admin has been notified. The order cannot be finished while such warnings are unresolved.

### Scan item into box (cross-order)

The **Boxes** section below the item list has a **Scan item into box** toggle per open box. With it armed, scanning a part barcode picks that item straight into the box — even when the item belongs to a *different* picking order (a box may hold packages from several orders). The system resolves the barcode across all open orders; if nothing matches or more than one order's item could match, a message explains why nothing was added. Scanning another box's toggle switches the armed box.

## 5. Handle issues

If the quantity is wrong, the item is damaged, or stock cannot be found, use the issue-reporting flow. See [Issue reporting](./issue-reporting.md).

## 6. Finish the order

When all lines are fully picked, the order status changes to finished and the order's packed boxes move on to measuring. No task is created at finish anymore — closing a box is the measuring completion, and each closed box gets its own verify task when the verify step is enabled.

If the order has unresolved outdated date-code warnings (warning chip on the order), the order does not finish — the auto-finish is skipped and the manual **Finish picking** action shows a message with the number of unresolved warnings. Ask an admin to resolve the order's warnings (admin console → Issues → Outdated warnings); the order finishes automatically once they are resolved.
