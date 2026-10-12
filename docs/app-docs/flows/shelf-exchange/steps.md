# Shelf Exchange — Operator Steps

## 1. Open Shelf Exchange

From the home screen, tap **Shelf Exchange**.

## 2. Scan the source shelf

Scan the shelf QR code of the shelf the stock is currently on. The shelf is shown in a banner at the top with a **Clear** button. Scanning a different shelf QR at this point re-selects the source.

## 3. Scan the item label

Scan the item's label (hardware scanner or the camera Scan button). The quantity to move comes from the label — there is no qty entry. The matched lot is resolved on the source shelf and shown as a card (part no, batch fields, qty, available).

If the label does not match stock on the shelf, or the label qty exceeds the unallocated quantity, an error toast explains why — fix the issue and scan again.

## 4. Scan the target shelf

Scan the shelf QR code of the destination shelf. Scanning the source shelf again is rejected (same shelf).

## 5. Confirm

A confirm dialog shows the resolved lot, the qty, and the source → target route. Tap **Move** to commit, or **Cancel** to keep the matched item and retry the target scan.

## 6. Repeat

After a confirmed move the source shelf stays selected — scan the next item label (step 3) to keep moving stock from the same shelf. Tap **Clear** on the source banner to start over with a different source shelf.
