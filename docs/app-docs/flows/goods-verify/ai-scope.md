# Goods Verify — AI Scope and Remarks

## In scope

- List goods-verify tasks.
- Show task detail with expected items.
- Scan/type part numbers for verification.
- Record verification results and discrepancies.
- Shelf-box contents are sourced from `put_away_scans` (shared with put-away).

## Out of scope

- Automated quality inspection.
- Photo capture for proof of condition.
- Integration with QA systems.

## Key files

- `pages/goods-verify/` — list and detail pages.
- `db/goodsVerify.ts` — goods verify DB helpers.

## Known limitations

- Verification is a simplified demo flow.
- No image or signature capture.
