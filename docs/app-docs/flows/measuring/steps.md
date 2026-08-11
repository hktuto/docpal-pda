# Measuring Steps

## 1. Open the measuring list

From the home screen, tap **Measuring**. The list shows the open shipping boxes that contain packages — a box may hold packages from several picking orders.

![Measuring list](./assets/measuring-list.png)

## 2. Open a box

Tap the box to open its page — or scan the box's QR code (or type its box id on the wedge) on the list page, which opens the box page directly.

## 3. Verify the packages

The box page lists the box's packages in a table. Scan each package's QR label with the hardware scanner — a matching package is verified immediately and its row flips to **Verified**. The per-row **Scan** button (camera OCR with review) is the fallback for labels the QR parser cannot handle.

## 4. Record measurements and confirm

When every package is verified, the measurements form opens automatically (or tap **Enter measurements**). Enter box size, net/gross weight in **kg** (decimals allowed — the net weight is pre-filled with the auto-calculated value from the part net-weight master; adjust it if needed), and destination country, then **Confirm box** to save and close the box in one action. See [Box measurements](./box-measurements.md).

## 5. Closing completes the measuring

There is no measuring task and no manual complete step: closing the box IS the measuring completion, and — when the verify step is enabled — a verify task is created for the box. Closed boxes leave the measuring list.
