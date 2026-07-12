# Goods Verify — AI Scope and Remarks

## In scope

- List goods-verify tasks.
- Show task detail with expected items.
- Scan/type part numbers for verification.
- Record verification results and discrepancies.
- Shelf-box contents are sourced from `put_away_scans` (shared with put-away).
- API pre-shipment verification: list/detail/complete `pre_shipment` verification tasks and verify individual shipping boxes.

## Out of scope

- Automated quality inspection.
- Photo capture for proof of condition.
- Integration with QA systems.

## Key files

- `pages/goods-verify/` — list and detail pages.
- `db/goodsVerify.ts` — goods verify DB helpers (pglite adapter only; api mode: `apps/api/src/db/measure.ts` / `putAway.ts` behind the routes below).
- `apps/api/src/routes/verification.ts` — `GET /verification-tasks` (filter by `kind`, `status`, `since`), `GET /verification-tasks/:id`, `POST /verification-tasks/:id/complete`.
- `apps/api/src/routes/boxes.ts` — `POST /shipping-boxes/:id/verify`.
- `apps/api/src/db/measure.ts` — `verifyShippingBox`, `completeVerificationTask` (both `pre_shipment` and `cycle_count` branches).
- `apps/api/src/routes/goodsVerify.ts` — cycle-count shelf browse (`GET /shelves`, `GET /shelves/with-box-counts`, `GET /shelves/:code/boxes`, `GET /shelf-boxes/:id`) and `POST /shelf-boxes/:id/verify-item`.
- `apps/api/src/db/putAway.ts` — `verifyShelfBoxItem`, `scheduleCycleCount`.
- `apps/api/src/db/pickScan.ts` — pick hook: `scanAllocation` from a boxed lot schedules a recount and resets the box.

## API semantics (Plan 5)

- A `pre_shipment` verification task is auto-created when a measuring task completes (see [measuring ai-scope](../measuring/ai-scope.md)).
- Pre-shipment verification is box-level: `POST /shipping-boxes/:id/verify` moves a box `closed → verified` (requires all its packages verified); `POST /verification-tasks/:id/complete` requires every box of the order to be `verified`.

## API semantics (Plan 6 — cycle count)

- A `cycle_count` verification task is scheduled whenever a shelf box's stock changes (scan assigned to / removed from a box, or a pick consumes a boxed lot). Tasks coalesce to one pending task per box per day.
- Due time is the next local 09:00, stored as UTC (e.g. `01:00:00Z` in a UTC+8 deployment).
- `POST /shelf-boxes/:id/verify-item {part_id}` marks that part's scans in the box as verified; 404 when the part has no unverified scans in the box.
- `POST /verification-tasks/:id/complete` on a `cycle_count` task requires the box to be `closed` and all its scans verified; on success the box flips to `verified`.
- Pick hook: picking from a boxed lot schedules a new `cycle_count` task, resets the box `verified → closed`, and marks its scans unverified.

## Known limitations

- Verification is a simplified demo flow.
- No image or signature capture.
- API: the `shelves` table has no `zone` column (unlike the web app), so shelf responses expose `code` only.
- API: cycle-count box contents aggregate live from `put_away_scans`; the `shelf_box_items` table is intentionally unused (see [put-away ai-scope](../put-away/ai-scope.md)).

## Related specs/plans

- `docs/superpowers/plans/2026-07-12-measuring-verification.md`
- `docs/superpowers/plans/2026-07-13-put-away-cycle-count.md`
