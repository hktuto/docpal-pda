# Ad-hoc Put-away

## Purpose

Ad-hoc put-away enables operators to put away items that have **no receiving order** — old store stock, write-out returns, or any item that needs to re-enter inventory. The flow is brand-driven (for scan/OCR parsing context), order-free, and commits directly to a shelf in one confirmation.

## Entry point

Home tile → **Ad-hoc Put-away** (`/ad-hoc-put-away`)

## Key concepts

- **Brand-driven parsing** — the selected brand (from `parts.brand`) scopes the label decode (`POST /scan/decode` with that brand's supplier profiles) and the scanner symbology whitelist.
- **No receiving order** — items are committed directly to inventory lots without a receiving order reference.
- **Location assignment** — the user selects one `(org_id, sub_inventory_code)` pair applied to all items (per-item pairs exist in the API payload but there is no per-item UI).
- **Date code defaulting** — new items default to today's date code in label format (per the `dateCodeFormat` flow config — WWYY for default `wwyy` warehouses); users can edit date code and lot code by batch or per item.
- **Shelf selection** — scan the shelf's QR/barcode (scan-only; the banner's × clears it).
- **One-shot commit** — all scanned items are committed to the selected shelf in one transaction.

## Related flows

- [Put-away](../put-away/overview.md) — standard put-away from receiving orders
- [Stock Search](../stock-search/overview.md) — search inventory after put-away
