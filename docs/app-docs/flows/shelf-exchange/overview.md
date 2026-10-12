# Shelf Exchange

## Purpose

Shelf exchange moves stock from one shelf to another — for reorganizing a shelf, consolidating leftovers, or relocating stock without a picking or receiving order. The flow is scan-driven end to end: scan the source shelf, scan the item label (the quantity comes from the label, no manual entry), scan the target shelf, and confirm.

## Entry point

Home tile → **Shelf Exchange** (`/shelf-exchange`)

## Key concepts

- **Scan-driven steps** — source shelf QR → item label → target shelf QR; a step hint on the page shows the current step.
- **Qty from the label** — the moved quantity is parsed from the scanned label, so there is no qty keypad anywhere in the flow.
- **Lot matching on the source shelf** — the scanned label resolves a lot on the source shelf (part no + batch fields, FIFO by date code), like a picking scan. No match or not enough stock → error before the target shelf is scanned.
- **Allocated stock is not movable** — the move is capped at the lot's unallocated quantity (`total − allocated`).
- **Merge on the target shelf** — if the target shelf already holds a lot with the same part + batch fields + location key, the qty is merged into it (a new lot row is created otherwise). The merged lot keeps its existing lot code.
- **Any shelf is a valid target** — the lot keeps its `(org_id, sub_inventory_code)` pair regardless of the target shelf.
- **Sticky source shelf** — after a confirmed move the source shelf stays selected for the next item; only the item and target clear.

## Related flows

- [Put-away](../put-away/overview.md) — put-away moves receiving stock onto a shelf
- [Ad-hoc Put-away](../ad-hoc-put-away/overview.md) — creates new stock on a shelf (no receiving order)
- [Stock Search](../stock-search/overview.md) — search inventory before/after a move
