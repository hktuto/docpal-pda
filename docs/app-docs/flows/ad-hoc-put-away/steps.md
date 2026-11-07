# Ad-hoc Put-away — Operator Steps

## 1. Open Ad-hoc Put-away

From the home screen, tap **Ad-hoc Put-away**.

## 2. Select a brand

Choose the brand of the items you are putting away (from the warehouse's
`parts.brand` values). This drives:
- Label parsing (the scan decode is scoped to that brand's supplier profiles)
- Scanner symbology whitelist (barcode types)

The brand selection persists across multiple put-away cycles.

## 3. Select a location

Choose the `(org_id, sub_inventory_code)` pair for the items. This is required because there is no receiving order to provide the location context. The location applies to all scanned items (the commit payload supports per-item pairs, but there is no per-item picker).

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

New items default to today's date code in label format (per the `dateCodeFormat` flow config — WWYY for default `wwyy` warehouses).

## 6. Select a shelf

Scan the shelf's QR/barcode — shelf codes are intercepted from the scan stream
and set the selected shelf (scan-only; there is no shelf dropdown). The
selected shelf is shown in the confirm prompt.

## 7. Confirm

Tap the confirm button to put all items to the selected shelf. A confirmation prompt shows the item count, total quantity, and shelf.

## 8. Repeat

After confirmation, the item list clears and the brand selection stays. Repeat from step 4 to scan more items for the same brand.
