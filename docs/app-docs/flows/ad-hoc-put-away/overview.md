# Ad-hoc Put-away

## Purpose

Ad-hoc put-away enables operators to put away items that have **no receiving order** — old store stock, write-out returns, or any item that needs to re-enter inventory. The flow is supplier-driven (for scan/OCR parsing context), order-free, and commits directly to a shelf in one confirmation.

## Entry point

Home tile → **Ad-hoc Put-away** (`/ad-hoc-put-away`)

## Key concepts

- **Supplier-driven parsing** — the selected supplier provides the OCR/QR parsing rules (qty encoding, date-code encoding) and the scanner symbology whitelist.
- **No receiving order** — items are committed directly to inventory lots without a receiving order reference.
- **Location assignment** — the user selects an `(org_id, sub_inventory_code)` pair for all items, with per-item override.
- **Date code defaulting** — new items default to today's date code (WWYY format); users can edit date code and lot code by batch or per item.
- **Shelf selection** — scan a shelf QR code or pick from a dropdown.
- **One-shot commit** — all scanned items are committed to the selected shelf in one transaction.

## Related flows

- [Put-away](../put-away/overview.md) — standard put-away from receiving orders
- [Stock Search](../stock-search/overview.md) — search inventory after put-away
