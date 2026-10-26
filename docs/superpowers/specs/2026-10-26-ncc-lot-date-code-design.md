# NCC lot and date-code decoding

## Problem

The built-in NCC template treated every 28-digit label as drawing(6) + ignored(3) + lot(7) + ignored(3) + qty(5) + serial(4). The confirmed layout is instead drawing(6) + lot(13) + qty(5) + serial(4), so the previous template discarded the first three lot digits and truncated its end. It also had no date-code decoding.

## Confirmed label format

For `4553136091015970033005000048`:

- `455313`: NCC drawing number, exposed as `itemId` for the existing part matching flow. Drawing-number-to-item-number lookup remains future work.
- `6091015970033`: complete lot code, returned as `60910-59700-33`.
- `00500`: quantity 500.
- `0048`: running serial number within the lot.

The first five lot digits are `YMMDD`: one year digit, two month digits, and two day digits. Thus `60910` is 2026-09-10. The year digit resolves to the latest matching year not after the scan year; for example, digit 9 scanned in 2026 means 2019. Invalid calendar dates produce no date code.

The calendar date becomes an ISO week date code. It is emitted in the configured label format: 2026-09-10 becomes `3726` for `wwyy` and `2637` for `yyww`, then follows the existing storage canonicalization boundaries.

## Compatibility and rollout

The 32-digit NCC_KTD layout keeps its existing field boundaries. Only 13-digit NCC lots use the new date decoding and 5–5–2 hyphenation. The seed, SQL restoration script, and a data migration carry the same corrected regex. The migration upgrades only rows still using the previous built-in regex, leaving customized supplier templates untouched.

Backend receiving and PDA scan parsing implement the same `ncc_lot_ymmdd` encoding. The admin supplier-profile editor exposes the encoding and previews its results.

## Verification

The user will manually verify real NCC scans. Automated tests are intentionally not added or run for this change; static type checks and source-consistency review only.
