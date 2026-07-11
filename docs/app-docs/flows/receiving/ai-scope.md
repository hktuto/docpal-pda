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
- `apps/api/src/routes/receiving.ts` — admin ingestion endpoints `PUT /receiving-orders/:external_id` and `POST /receiving-orders/:external_id/confirm-arrival`.
- `apps/api/src/ingest/receiving.ts` (with `ingest/parts.ts`, `ingest/suppliers.ts`, `ingest/transition.ts`) — idempotent order upsert and the arrival transition that flips the order to `in_hand`, sets `received_qty = qty`, and logs the transition.
- `apps/api/src/db/allocate.ts` — confirm-arrival triggers `allocateAll`, which allocates available received stock to open picking orders.

## Known limitations

- Demo-only data; no real supplier integration.
- Mismatch resolution rules are simplified.
- The admin payload field names for the ingestion endpoints are currently PROPOSED (`external_id` on the order, receiving lines keyed by `invoice_no` + `line_no`, picking lines keyed by `line_id`) — to be reconciled with the real admin app.
- OCR-assisted picking from the Picking view uses local scan candidate search (`findReceivingCandidates` / `findPickingCandidates` in `composables/useScanMatchers.ts`) that is not part of `WarehouseService` and has no API equivalent.

## Related specs/plans

- `docs/superpowers/specs/2026-07-01-receiving-list-picking-order-count-design.md`
- `docs/superpowers/specs/2026-07-03-receiving-mismatch-design.md`
