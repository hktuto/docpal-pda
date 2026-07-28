# Verify Steps

## 1. Open the verify list

From the home screen, tap **Verify**. The list shows pending verify tasks for finished picking orders (created when a measuring task is completed).

## 2. Select a verify task

Tap the task to open the detail page. The detail shows the picking order and every shipping box with its package-verification progress and recorded measurements.

## 3. Reopen a box if it needs correction

Closed boxes show a **Reopen** button while the task is pending. Reopening returns the box to open and clears its packages' verified flags (both passes), so they must be scanned again before the box can be re-closed.

## 4. Open a box

Either tap **Open box** on the box card, or scan the box's QR code (or type its box id on the wedge) — scanning opens the box page directly.

## 5. Re-verify the packages

The box page (shared with measuring) lists the box's packages in a table. Scan each package's QR label with the hardware scanner — a matching package is re-verified immediately and its row flips to **Verified**. Scanning works on closed boxes too: the normal verify pass checks every item against the sealed box without reopening it. The per-row **Scan** button (camera OCR with review) is the fallback for labels the QR parser cannot handle.

Every package of the order must be re-scanned in this pass — the task cannot complete until all of them are.

## 6. Correct measurements if needed

When every package in an open box is verified, the measurements form opens automatically (or tap **Enter measurements**). Box size, net/gross weight (kg — the net weight pre-fills from the part net-weight master), and destination country can be edited; then **Confirm box** closes the box again. See [Box measurements](../measuring/box-measurements.md).

## 7. Complete the task

When every box is closed and every package has been re-scanned, tap **Complete verify** on the task detail (the button appears only then). The order moves on to shipping.
