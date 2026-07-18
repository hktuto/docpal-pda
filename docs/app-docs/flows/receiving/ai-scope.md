# Receiving — AI Scope and Remarks

## In scope

- List receiving orders with a status filter
  (`pending` / `provisional_received` / `in_hand` / `clear`) and a pending
  picking-order count badge per order (computed server-side).
- Show receiving order detail as one nested read: supplier (+ PDA profile),
  invoices → items (part embedded), each item carrying its flat mismatch
  columns.
- Confirm arrival (flips the order toward `in_hand` and triggers the
  backend's best-effort allocation pass).
- Label scanning with **server-side parse/match**: the raw label goes to
  `POST /receiving-orders/:id/scan`; on a 409 `{message, candidates}`
  (`no_match` / `multiple_matches`) the review modal lets the operator pick
  a candidate and resend with an explicit `{partNo, qty}` (the raw rides
  along so serial dedup still applies).
- S-key serial dedup: a parsed `serialNo` (KOA S-key) is recorded per order
  in `receiving_scan_labels`; a repeat serial is rejected with
  `409 label_already_scanned`. Scans without a serial skip dedup.
- Report, edit, confirm, and cancel receiving item mismatches — **item-keyed**
  (every call addresses the receiving invoice item id; the mismatch is a set
  of flat columns on the item, no separate table, no status/reporter).
  Confirm writes a transition log; cancel clears the flag.
- Show the order's picking section (nested orders with items, allocations,
  packages, transition logs, and shipping boxes) on the detail's Picking tab.

## Out of scope

- ASN (advance shipping notice) import.
- Supplier label printing.
- Integration with carrier tracking.
- Quality inspection hold statuses.
- Client-side scan candidate search (`getScanCandidates` /
  `/scan-candidates`) — removed; matching is server-side now.

## Key files

- `pages/receiving/index.vue` — list page (status filter + picking badge).
- `pages/receiving/[id].vue` — detail page (items + picking tabs, confirm
  arrival, scan entry points).
- `components/receiving/ReceivingItemsTab.vue`,
  `components/receiving/ReceivingPickingTab.vue` — detail sub-views.
- `components/receiving/ReceivingScanReviewModal.vue` — candidate review
  dialog for scan 409s.
- `composables/useReceivingScan.ts` — scan submission + 409 → review flow.
- `components/ReportIssueModal.vue` + `utils/mismatch.ts`
  (`validateMismatchInputs`) — mismatch dialog and its pure validation.
- `services/adapters/backendWarehouse.ts` — receiving + mismatch methods.
- `apps/backend/src/routes/receiving.ts` + `apps/backend/src/db/receiving.ts` —
  `GET /receiving-orders?status=`, `GET /receiving-orders/:id` (+`/picking`),
  `POST .../confirm-arrival`, `POST .../scan` (with serial dedup), and the
  item-keyed mismatch CRUD: `GET|POST|PATCH
  /receiving-invoice-items/:id/mismatch`, `POST .../mismatch/confirm|cancel`.
- `apps/backend/src/routes/ingest.ts` + `apps/backend/src/db/ingest.ts` —
  `PUT /receiving-orders/:externalId` upsert (nullable `external_id`, unique).
- `apps/backend/src/db/allocate.ts` — `allocateAll` runs best-effort after
  confirm-arrival and other stock-changing commits.

## Known limitations

- Demo-only data; no real supplier integration.
- Mismatch resolution rules are simplified (flat columns; confirm/cancel
  only — no approval chain).
- Allocation runs are best-effort: a failure never rolls back the committed
  write.

## Related specs/plans

- `docs/backend/api-design.md` §Receiving
- `docs/superpowers/specs/2026-07-01-receiving-list-picking-order-count-design.md`
- `docs/superpowers/specs/2026-07-03-receiving-mismatch-design.md`
