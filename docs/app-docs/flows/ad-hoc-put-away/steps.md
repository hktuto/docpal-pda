# Ad-hoc Put-away — Operator Steps

## 1. Open Ad-hoc Put-away

From the home screen, tap **Ad-hoc Put-away**.

## 2. Select a supplier

Choose the supplier whose items you are putting away. This drives:
- OCR/QR label parsing (qty encoding, date-code encoding)
- Scanner symbology whitelist (barcode types)

The supplier selection persists across multiple put-away cycles.

## 3. Select a location

Choose the `(org_id, sub_inventory_code)` pair for the items. This is required because there is no receiving order to provide the location context. The location is applied to all items by default, with per-item override available.

## 4. Scan items

Tap **Scan** to capture item labels:
- **Hardware scanner** — scans QR codes and barcodes
- **Camera OCR** — captures label text for parsing

Each scanned item is added to the review list. Shelf QR codes are intercepted and set the selected shelf.

## 5. Review and edit items

The scanned items are shown in a list. You can:
- **Edit date code / lot code** — tap on an item to edit its date code or lot code
- **Batch edit** — enter a date code or lot code in the batch fields and tap "Apply to all"
- **Remove items** — tap × to remove a mis-scanned item

New items default to today's date code (WWYY format).

## 6. Select a shelf

Scan a shelf QR code or pick a shelf from the dropdown. The selected shelf is shown in the confirm prompt.

## 7. Confirm

Tap the confirm button to put all items to the selected shelf. A confirmation prompt shows the item count, total quantity, and shelf.

## 8. Repeat

After confirmation, the item list clears and the supplier selection stays. Repeat from step 4 to scan more items for the same supplier.
