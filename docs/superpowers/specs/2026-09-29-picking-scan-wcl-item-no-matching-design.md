# Picking scan: wcl_item_no matching, space-insensitive compare, brand-scoped templates

Date: 2026-09-29
Status: implemented

## Problem

Scanning a KOA reel label `:SR732ERTTDR200F::153:K:19077387:S002:KOA/SR732ERTTDR200F:13FSJ564:01`
on picking order ME2610-0006 returned "no match". Root causes:

1. The KOA template captured only the `itemId` segment (`SR732ERTTDR200F`) — the bare MPN
   with no `KOA/` prefix and no internal space. Picking items store the WCL item no
   (`KOA/SR732ERTTD R200F`) as `part_no`, so the client-side exact compare failed. The
   WCL item no is printed on the label (segment 7) but the template swallowed it into the
   ignored `fullName` tail.
2. Client part-number compare (`normalize` in useMockOcr) only collapsed whitespace to a
   single space; QR part numbers carry no spaces at all, so `SR732ERTTD R200F` ≠
   `SR732ERTTDR200F` even without the prefix issue.
3. The scan page tried all supplier templates in `supplier_code` order with no notion of
   which supplier the order belongs to.

## Design

### KOA template captures wclItemNo

New template (segment 7 becomes a named `wclItemNo` group; further segments and an
optional trailing delimiter are ignored):

```
^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<wclItemNo>[^:]+)(?::[^:]*)*:?$
```

Segment map: `[1] part_no [2] ignore [3] qty [4] ignore [5] lotCode [6] serialNo
[7] wclItemNo [8+] ignore`. Backward-compatible: old raws whose tail is `KOA+<mpn>`
(with or without trailing colons) still match — the tail simply lands in `wclItemNo`
and the `itemId` fallback keeps matching those parts.

### wclItemNo flows through both parsers

- Backend `scanParse.ts parseQrRaw` returns `wclItemNo` (new optional `ParsedScanFields`
  member). The receiving scan match (`receiving.ts`) accepts it as an alternative key:
  an item matches when any of `[partNo, wclItemNo, partWclItemNo]` (normalized) equals the
  normalized scanned `partNo` **or** `wclItemNo`.
- Web `parseQrCapture` extracts `groups.wclItemNo` into `ParsedFields.wclItemNo`;
  `ocrResultToInput` maps it onto `OcrInput.wclItemNo`.

### Space-insensitive part matching

New web util `normalizePartNo` (`apps/web/utils/text.ts`): uppercase + strip ALL
whitespace (mirrors the backend's `normalizePartNo`). Used for every part-number
comparison in the scan matchers:

- `usePickingScanQueue.findTarget/findTargets`: an item matches when
  `normalizePartNo(item.partNo)` or `normalizePartNo(item.wclItemNo)` equals
  `normalizePartNo(parsed.partNo)` or `normalizePartNo(parsed.wclItemNo)`.
- `useScanMatchers` matchPicking/matchPutAway/matchMeasuring partNo compares switch to
  `normalizePartNo`; put-away also accepts the receiving item's `wclItemNo`.

### Brand-scoped template lookup

`supplier_profiles` gains a PDA-local `brands text[]` column (nullable = unknown, same
pattern as `barcode_types`), seeded for the built-in profiles (KOA, NCC, COPAL/NIDEC,
SII, ABLIC, TE, NDK) and maintained via seed/SQL like `barcode_types`. The picking order
detail exposes each item's `parts.brand`; `GET /scan-templates` returns `brands`. The
picking scan page passes the order's brand set as `contextBrands` to `parseQrCapture`,
which tries brand-intersecting templates first and the rest after — a fallback, not a
hard filter, so mixed-brand or unmapped-brand orders still parse.

### Migration

A drizzle migration adds the column and carries data UPDATEs: supplier `32` (KOA) gets
the new `qr_template` (guarded on the old value), and the seven built-in profiles get
their `brands`. Existing databases pick this up on backend startup.

## Verification

- Backend: KOA parse tests assert `wclItemNo`; the real ME2610-0006 barcode is a fixture
  (partNo `SR732ERTTDR200F`, qty `15000` via koa_zeros, lotCode `19077387`, wclItemNo
  `KOA/SR732ERTTDR200F`). `buildKoaLabelRaw` round-trip stays green.
- Web: `parseQrCapture` wclItemNo extraction + brand ordering; `usePickingScanQueue`
  space-stripped wclItemNo match (the ME2610-0006 scenario).
