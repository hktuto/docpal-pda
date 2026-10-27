# NCC lot and date-code decoding

## Problem

The built-in NCC template treated every 28-digit label as drawing(6) + ignored(3) + lot(7) + ignored(3) + qty(5) + serial(4). The confirmed layout is instead drawing(6) + lot(13) + qty(5) + serial(4), so the previous template discarded the first three lot digits and truncated its end. It also had no date-code decoding.

A follow-up scan showed that the first corrected regex was still ambiguous: `\d{6,10}` and the variable-width lot could backtrack into the old boundaries, producing item `592884603` instead of `592884`. The 28- and 32-digit layouts therefore need remaining-length assertions, not optional variable-width fields.

## Confirmed label format

For `5928846030912801026002000460`:

- `592884`: NCC drawing number, exposed as `itemId` for the existing part matching flow. Drawing-number-to-item-number lookup remains future work.
- `6030912801026`: complete raw lot code, returned as `60309-0128010-26`.
- `00200`: quantity 200.
- `0460`: running serial number within the lot.

The first five lot digits are `YMMDD`: one year digit, two month digits, and two day digits. Thus `60309` is 2026-03-09. The year digit resolves to the latest matching year not after the scan year; for example, digit 9 scanned in 2026 means 2019. Invalid calendar dates produce no date code.

The calendar date becomes an ISO week date code. It is emitted in the configured label format: 2026-03-09 becomes `1126` for `wwyy` and `2611` for `yyww`, then follows the existing storage canonicalization boundaries.

## Compatibility and rollout

The 32-digit NCC_KTD layout keeps its existing field boundaries. Only 13-digit NCC lots use the new date decoding and 5–7–2 hyphenation. The seed, SQL restoration script, and data migrations carry the same corrected regex. Each migration upgrades only rows still using the immediately previous built-in regex, leaving customized supplier templates untouched.

Backend receiving and PDA scan parsing implement the same `ncc_lot_ymmdd` encoding. The admin supplier-profile editor exposes the encoding and previews its results.

## Verification

Backend and PDA regression tests cover the reported 28-digit scan in both date-code formats and a 32-digit NCC_KTD compatibility sample. The real-sample template harness checks all recorded supplier scans.
