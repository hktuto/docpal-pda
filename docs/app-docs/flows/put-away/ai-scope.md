# Put-away — AI Scope and Remarks

## In scope

- List put-away candidates (in-hand receiving orders with unboxed received
  pieces).
- Show the put-away detail as **one aggregate read**
  (`GET /receiving-orders/:id/put-away`): expected invoice items (with
  remaining qty), materialized inventory lots, staging scans, and the
  non-staging shelf boxes with their item rows.
- Scan physical pieces into the order's staging box (client-side label
  validation against supplier QR templates).
- Assign staging scans into shelf boxes (one box per shelf), add-all-unboxed,
  remove-from-box, and remove scanned pieces.
- Create / close / cancel shelf boxes; closing materializes inventory lots
  and auto-clears the receiving order when its last piece is boxed.
- Select a destination shelf (the `/admin/shelves` CRUD read doubles as the
  shelf list).

## Out of scope

- Automated put-away suggestions based on velocity or zone.
- Forklift or robot integration.
- Multi-step directed put-away with confirmation checkpoints.

## Key files

- `pages/put-away/index.vue` — candidate list.
- `pages/put-away/[id].vue` — detail page (expected items, lots, scans,
  boxes; scan entry).
- `components/put-away/PutAwayLotsPanel.vue` — expected items and scan
  staging.
- `components/put-away/ShelfBoxesPanel.vue` — shelf boxes and scan
  assignment.
- `components/SelectShelfDialog.vue` — shelf selection UI.
- `composables/useScanMatchers.ts` — client-side `matchPutAway` validation;
  apply calls `WarehouseService.recordPutAwayScan`.
- `services/adapters/backendWarehouse.ts` — put-away + shelf-box methods.
- `apps/backend/src/routes/putaway.ts` + `apps/backend/src/db/putaway.ts` —
  `GET /put-away/candidates`, `GET /receiving-orders/:id/put-away`,
  `POST /receiving-orders/:id/put-away-scans`, `DELETE
  /put-away-scans/:scanId`, `/shelf-boxes*` lifecycle (lot materialization
  + receiving-order auto-clear).

## Known limitations

- Shelf selection is manual; no validation of shelf capacity or restrictions.
- Scanned pieces are tracked per receiving invoice item. The app does not
  support splitting a single scanned piece across multiple boxes.
- Put-away scans do not yet dedup by serial (the `receiving_scan_labels`
  table built for receiving-scan dedup can be reused for this later).

## Related specs/plans

- `docs/backend/api-design.md` §Put-away
- `docs/superpowers/specs/2026-07-03-cancel-empty-box-design.md`
- `docs/superpowers/specs/2026-07-06-put-away-scan-first-design.md`
- `docs/superpowers/plans/2026-07-06-put-away-scan-first.md`
