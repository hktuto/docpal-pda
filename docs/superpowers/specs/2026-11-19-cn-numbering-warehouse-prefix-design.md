# CN numbering — warehouse prefix on every generated number

Date: 2026-11-19 · App: backend · Functions: ADM-023, PDA-008
Builds on: `2026-11-08-receiving-cn-excel-local-upload-design.md`,
`2026-11-10-receiving-cn-truck-manifest-upload-design.md`,
`2026-11-17-receiving-cn-manifest-single-order-design.md`

## Problem

One backend instance runs per warehouse (HK/SZ/SH/BJ), each with its own
database — and each generates its CN numbers locally. Nothing stopped the SZ
instance and the HK instance both minting `TE-20261119-01` (pdf upload /
manual receipt), `KOA-20261119-01` (local Excel upload), or
`202611171-20261118` (truck manifest) on the same day. HQ-side reports and
the DocPal workflow trail aggregate across warehouses, so the numbers must
be fleet-unique even though the databases never meet.

## Decision

**Every locally generated CN number carries the warehouse prefix** —
`WAREHOUSE_CODE` uppercased (default `hk`), read at generation time from the
same env that already drives shelf seeding, the org map and the bug-report
instance stamp. No new configuration.

- `nextCnBrandedNo` → `[WH]-[brand]-yyyymmdd-[seq]` — covers the local
  Excel upload's order batch_no, manual-receipt `invoice_no` (which is also
  the order's batch_no), and pdf-upload workflow batch_no (stamped onto the
  order by the upstream sync — same string by construction).
- `nextCnTruckNo` → `[WH]-[truckRef]-YYYYMMDD(-seq)` — the truck-manifest
  車單 order number.
- `generateCnBatchNo` (random `CN-yyyymmdd-XXXXXX`) — unchanged: it is a
  correlation key for the retired DocPal-workflow excel phase, random enough
  to never collide, never an operator-facing number.
- The advisory-lock keys gain the warehouse segment
  (`cn-numbering:[WH]-[brand]-[ymd]`, `cn-truckno:[WH]-[ref]-[ymd]`), the
  MAX scan's `split_part` moves to segment 4, and the match regex is rebuilt
  from the full prefix. `brand` is now sanitized inside the function (was
  only documented at the call sites) so the regex can never break.
- HK included: new HK numbers are `HK-TE-20261119-01` etc. (operator
  decision 2026-11-19 — uniform rule, easiest to document and validate).

**No migration.** Legacy unprefixed rows (`TE-20261104-01`,
`202611171-20261118`, `KOA-…`) keep their shape; the prefixed namespace
starts each warehouse's sequence fresh because the strings can never
collide. The MAX scan only sees rows matching the new prefix, so an old
high seq does not bump the new one.

Downstream consumers checked: the PDA opens orders/tasks via
`warehouse://` id links (not batch_no), the admin/PDA lists display the
batch_no verbatim, and the upstream sync matches the workflow's batch_no
by exact string — all prefix-agnostic.

## Ceilings

- Operators see the new shape from the next created order; paper/packing
  lists printed before the cutover keep the old shape (historical rows are
  never rewritten).
- A warehouse code outside `[A-Z0-9]` is stripped by the sanitizer; an
  empty result falls back to `HK`.

## Files

- `apps/backend/src/db/receivingCn.ts` — `cnNumberPrefix()` +
  the two numbering functions.
- `apps/backend/src/routes/receivingCn.test.ts` — format assertions updated
  (`HK-…`), race-test seq index moved to segment 4, new prefix test (SZ env
  + legacy-row restart).
- `docs/backend/api-design.md` — both format mentions.

## Verification

- `pnpm --filter @warehouse/backend build` (tsc) — clean.
- `tsx --test src/routes/receivingCn.test.ts` — 9/9 pass (incl. the new
  WAREHOUSE_CODE=sz prefix + legacy-restart test and the advisory-lock race
  test).
- Manual: upload any sheet / post a manual receipt on the SZ instance →
  batch `SZ-…`; HK instance → `HK-…`; same-day second upload → `-02`.
