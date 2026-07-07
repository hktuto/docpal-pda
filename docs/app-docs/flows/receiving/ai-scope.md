# Receiving — AI Scope and Remarks

## In scope

- List receiving orders.
- Show receiving order detail with invoices and items.
- Confirm received quantities.
- Report receiving mismatches (shortage, overage, wrong item, damage).
- Approve, edit, and cancel receiving item mismatches via `db/mismatch.ts` (statuses: `pending`, `confirmed`, `cancelled`).
- Automatically re-evaluate parent receiving-order `clear`/`in_hand` status after mismatch changes.
- Create receiving-area inventory lots.
- Show pending picking order count badge on the list.
- Two views on detail: Receiving and Picking.
- OCR-assisted picking from the Picking view.

## Out of scope

- ASN (advance shipping notice) import.
- Supplier label printing.
- Integration with carrier tracking.
- Quality inspection hold statuses.

## Key files

- `pages/receiving/` — list and detail pages.
- `components/receiving/` — receiving-specific components.
- `db/receiving.ts` — receiving DB helpers and order status transitions.
- `db/mismatch.ts` — mismatch report/confirm/edit/cancel lifecycle.
- `db/init.ts` — schema bootstrap.

## Known limitations

- Demo-only data; no real supplier integration.
- Mismatch resolution rules are simplified.

## Related specs/plans

- `docs/superpowers/specs/2026-07-01-receiving-list-picking-order-count-design.md`
- `docs/superpowers/specs/2026-07-03-receiving-mismatch-design.md`
