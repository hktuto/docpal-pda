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
- `db/goodsVerify.ts` — goods verify DB helpers.
- `apps/api/src/routes/verification.ts` — `GET /verification-tasks` (filter by `kind`, `status`, `since`), `GET /verification-tasks/:id`, `POST /verification-tasks/:id/complete`.
- `apps/api/src/routes/boxes.ts` — `POST /shipping-boxes/:id/verify`.
- `apps/api/src/db/measure.ts` — `verifyShippingBox`, `completeVerificationTask`.

## API semantics (Plan 5)

- A `pre_shipment` verification task is auto-created when a measuring task completes (see [measuring ai-scope](../measuring/ai-scope.md)).
- Pre-shipment verification is box-level: `POST /shipping-boxes/:id/verify` moves a box `closed → verified` (requires all its packages verified); `POST /verification-tasks/:id/complete` requires every box of the order to be `verified`.
- Cycle-count verification tasks (`kind` other than `pre_shipment`) are not completable through these endpoints yet — still pending (Plan 6).

## Known limitations

- Verification is a simplified demo flow.
- No image or signature capture.
- No UI pages are wired to the API verification endpoints yet; they are exercised via HTTP only.

## Related specs/plans

- `docs/superpowers/plans/2026-07-12-measuring-verification.md`
