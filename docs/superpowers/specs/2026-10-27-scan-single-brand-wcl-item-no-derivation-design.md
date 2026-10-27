# Scan matching: single-brand wcl_item_no derivation + WCL-item-no preference

Date: 2026-10-27
Status: implemented

## Problem

ABLIC reel QRs are `$`-delimited and carry only the bare MPN (twice), qty,
lot, yyyymm date code and serial:

```
1$S-812C33AMC-C2NT2U$3000$VM5F6XA0033-0308$S-812C33AMC-C2NT2U$202606$66VM1953007
```

The seeded SII/ABLIC template already extracts the fields (itemId = the
MPN-repeat segment). But `parts.part_no` is NOT unique — the same MPN can sit
under several WCL item numbers (`ABLIC/S-812C33AMC-C2NT2U`,
`OTHER/S-812C33AMC-C2NT2U`), so a scan matching on the bare part_no alone can
hit several order lines (`multiple_matches` in receiving, cross-brand line
splits in picking). Unlike KOA, the ABLIC label prints no WCL item no segment
to disambiguate.

## Design

### Single-brand wclItemNo derivation

`supplier_profiles.brands` already scopes template lookup. When the matched
template produces no `wclItemNo` group value and the profile covers **exactly
one brand**, both parsers derive `wclItemNo = "<brand>/<itemId>"`:

- backend `deriveWclItemNo` in `apps/backend/src/db/scanParse.ts`
  (`parseQrRaw` gains a trailing `brands` param; `scanReceivingOrder` passes
  the order supplier profile's `brands`),
- PDA `parseQrCapture` in `apps/pda/utils/parseOcrScan.ts` (same rule from
  the matched `SupplierQrcodeTemplate.brands`).

ABLIC parts are stored as `wcl_item_no = "ABLIC/" + part_no`, so the derived
key matches. Multi-brand (COPAL/NIDEC) or brand-less profiles never derive —
the bare partNo stays the only key. An explicit `wclItemNo` group (KOA
segment 7, iC-Haus CANR) always wins over the derivation.

### WCL-item-no preference in multi-candidate matching

Wherever a scan is matched against a POOL of items, a scanned `wclItemNo`
(explicit or derived) that matches ≥1 candidate narrows the pool to those
candidates; with no wcl match the fallback is the previous union of both
keys. Implemented in:

- backend `scanReceivingOrder` (`apps/backend/src/db/receiving.ts`),
- PDA `filterScannedPartMatches` (`apps/pda/utils/text.ts`), used by
  `usePickingScanQueue.findTarget/findTargets`, `matchPutAway`
  (`useScanMatchers.ts`) and `matchAggregatePackages`
  (`measuringAggregateMatch.ts`).

Single-target matchers (`matchPicking` against a pre-selected allocation,
`addToAllocation`) are unchanged — the derived key simply widens what they
accept.

## Date code: YYYYMM → week code (`yyyymm_midmonth`)

The ABLIC/SII label's segment 5 date code is a YYYYMM month (`202606`). To
store it as a week date code (canonical YYWW / label WWYY like every other
supplier), a new `date_code_encoding` value `yyyymm_midmonth` anchors the
month on the 15th — `202606` → 2026-06-15 → ISO week 25 → WWYY `2526` —
implemented by `decodeYyyymmMidmonthDateCode` in both parsers
(`apps/backend/src/db/scanParse.ts`, `apps/pda/utils/parseOcrScan.ts`) and set
on the 70915/84915 supplier profiles in the seed, in
`scripts/sql/restore-supplier-profiles-whhk.sql`, and for existing databases
via migration `0042_ablic_yyyymm_date_code.sql` (guarded on a NULL encoding).
The admin supplier-profile editor offers the option (with preview decode).

## Verification

- Backend: `parseQrRaw` unit test parses a real-shape ABLIC raw (fields +
  derived `ABLIC/S-812C33AMC-C2NT2U`; no derivation without brands / with a
  multi-brand list; explicit group wins for KOA), `decodeYyyymmMidmonthDateCode`
  unit tests, plus a `scanReceivingOrder` integration test with two
  same-part_no lines (ABLIC + OTHER wcl item nos) landing on the ABLIC line
  only and storing the decoded WWYY date code.
- PDA: `parseQrCapture` derivation + decode tests, a `usePickingScanQueue`
  two-line preference test, and a `matchAggregatePackages` preference +
  fallback test.
