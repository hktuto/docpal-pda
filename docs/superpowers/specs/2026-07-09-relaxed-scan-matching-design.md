# Relaxed Scan Matching

## Goal
Make receiving scan matching accept a label as long as the part number (itemId) matches and the scanned quantity is within available stock. Stop requiring date code, lot code, COO, and COW to match.

## Scope
- Receiving scan matching only.
- Picking matching already uses part number + quantity, so no change is needed there.
- Put-away, measuring, and goods-verify matchers are out of scope.

## Change
In `db/ocrPicking.ts`, update `findReceivingCandidates` to:
- Keep part number equality check.
- Keep quantity check (`available_qty >= scanned qty`).
- Remove `date_code`, `lot_code`, `coo`, and `cow` WHERE conditions.

Scanned date/lot/coo/cow values will still be passed through and stored on the created package via the existing `applyOcrPick` flow.

## Tests
- Update `tests/scanMatchers.test.ts` if any existing test relies on strict field matching.
- Verify `pnpm test` still passes.
