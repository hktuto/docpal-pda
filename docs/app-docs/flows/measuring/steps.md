# Measuring Steps

## 1. Open the measuring list

From the home screen, tap **Measuring**. The list shows measuring tasks for finished picking orders.

![Measuring list](./assets/measuring-list.png)

## 2. Select a measuring task

Tap the task to open the detail page. The detail shows the picking order and every shipping box with its package-verification progress and any recorded measurements.

## 3. Open a box

Either tap **Open box** on the box card, or scan the box's QR code (or type its box id on the wedge) — scanning opens the box page directly.

## 4. Verify the packages

The box page lists the box's packages in a table. Scan each package's QR label with the hardware scanner — a matching package is verified immediately and its row flips to **Verified**. The per-row **Scan** button (camera OCR with review) is the fallback for labels the QR parser cannot handle.

## 5. Record measurements

When every package is verified, the measurements form opens automatically (or tap **Enter measurements**). Enter box size, net/gross weight in **kg** (decimals allowed — the net weight is pre-filled with the auto-calculated value from the part net-weight master; adjust it if needed), and destination country, then **Confirm box** to save and close the box in one action. See [Box measurements](./box-measurements.md).

## 6. Task completes automatically

There is no manual complete step: when the last box of the order is confirmed, the measuring task completes automatically and — when the verify step is enabled — a verify task is created for the order. The task detail shows the completed status on reload.
