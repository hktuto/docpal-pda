# NCC drawing-number → part lookup — design

Date: 2026-11-03
Status: implemented

## Context

NCC (Chemi-Con) reel barcodes are fixed-width 28/32-char all-digits labels.
The supplier template's `itemId` group is a **numeric drawing code** (e.g.
`424307`), not the MPN and not the WCL item no — so scans of NCC labels match
no order item via the normal part_no / wcl_item_no matching.

The mapping lives in the externally-managed table `wcl_part_drawno`
(upstream NCC drawing→item map; **not** in the Drizzle schema or migrations —
raw `sql` only): `id varchar(100) PK`, `wcl_part_no varchar(255)` (→
`parts.wcl_item_no`), `drawno varchar(2000)`. Data facts: drawno is not
unique (duplicate rows per org — hence DISTINCT); ~414 drawno values map to
multiple distinct wcl_part_no (all are returned; the caller disambiguates);
some drawno values embed the code in a longer string (e.g. `REF#826558`).

## Decisions

- **Exact-then-substring lookup** (`lookupPartsByDrawingNo` in
  `src/db/partDrawno.ts`): exact `drawno =` match first; only when that finds
  nothing, a `LIKE '%code%'` substring fallback (LIKE metacharacters in the
  input escaped, `ESCAPE '\'`). Exact wins because a bare code must not be
  hijacked by longer REF#-style strings.
- **LEFT JOIN parts** on `wcl_item_no`: a wcl_part_no missing from `parts`
  still resolves (wclItemNo known, partNo null).
- **NCC-brands gate**: the fallback runs only when the supplier profile's
  `brands` include `NCC` (the receiving order's supplier / the matched
  template's supplier) — other suppliers' numeric itemIds are unaffected.
- **Missing-table tolerance**: a `42P01` (undefined_table) error warns once
  and resolves to no matches, so fresh dev databases without the external
  table keep working.
- **Receiving scan hook** (`scanReceivingOrder` in `src/db/receiving.ts`):
  after the existing wcl-preference + union-fallback matching computes zero
  matches, the scanned itemId is resolved and the union match is re-run with
  the resolved wcl_item_no / part_no values; the existing zero/multiple-match
  409 handling then applies unchanged.
- **Decode service hook** (`decodeScan` in `src/decode/service.ts`):
  - Case A: a matched NCC template hit without a wclItemNo gets
    `parsed.wclItemNo` attached when the drawing code resolves to exactly one
    wcl_item_no (itemId stays the drawing code).
  - Case B: when the order-targets gate rejected the match, the decode is
    re-run ungated; the ungated match is returned (with the resolved
    wclItemNo) only when exactly one resolution lands inside the normalized
    targets. `template.ts` stays pure — all DB access is in `service.ts`.
- **Out of scope**: the PDA's client-side picking/put-away label matching is
  NOT covered — it needs the deferred `/scan/decode` cutover (spec
  `docs/superpowers/specs/2026-11-03-backend-scan-decode-design.md`).
