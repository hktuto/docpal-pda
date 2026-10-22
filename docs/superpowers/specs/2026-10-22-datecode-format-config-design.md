# Date-code format config — YYWW canonical, WWYY receiving enclave — design

Date: 2026-10-22

## Problem

The system hard-assumes WWYY (week-week-year-year) date codes everywhere:
the canonical parser/rank (`apps/backend/src/db/dateCode.ts:14`), its raw-SQL
mirror (`src/db/stocksearch.ts:19-21`), FIFO allocation ordering
(`src/db/allocate.ts:255,306` — lexicographic string compare), outdated-scan
checks (`src/db/outdated.ts`), scan decoding (`src/db/scanParse.ts`), and
mirrored helpers in the PDA (`apps/pda/utils/wwyyDateCode.ts`,
`utils/parseOcrScan.ts`, `utils/dateCode.ts`) and admin (`apps/admin/utils/dateCode.ts`).

WWYY does **not** sort chronologically: `"5226"` (wk 52, 2026) vs `"0127"`
(wk 01, 2027) — plain string order puts week 1 of next year before week 52 of
this year. The lexicographic `ORDER BY date_code` in `allocate.ts` and
`stocksearch.ts` is therefore subtly wrong for ~1 week every January.

Meanwhile HK's upstream sync delivers receiving orders in WWYY (matching the
physical supplier labels, e.g. KOA), and other warehouses (e.g. SZ) use YYWW
labels. The warehouse wants YYWW as the working format because it sorts and
filters naturally.

## Decision

**YYWW is the canonical storage format for everything downstream of
receiving. The receiving flow keeps date codes in the label/upstream format
("the receiving enclave").** One config key describes the enclave's format.

- New top-level flow config `dateCodeFormat`: `"wwyy"` (default) | `"yyww"`.
  Semantics: **the format that upstream receiving data and physical supplier
  labels use** — i.e. the format of the receiving enclave. Canonical stored
  format is always YYWW. Follows the `pickingShelfScan` pattern: validated at
  boot, admin-editable via `GET/PUT /admin/flow-config`, `FLOW_CONFIG` env
  override wins, resolved onto `GET /config` for the PDA.
- With canonical YYWW, plain lexicographic order is chronological. The
  rank-based SQL (`DC_RANK`, `dateCodeRank` week-first slicing) is re-oriented
  to YYWW and stays for thresholds/filters; the FIFO/ordering `ORDER BY`s
  become correct as-is.
- HK (default `wwyy`): upstream sync and supplier labels keep arriving in
  WWYY; the system converts at the enclave boundary. SZ (`yyww`): labels are
  already YYWW, conversion is a pass-through.

### Conversion helpers

`swapDateCode(code)` — `WWWW ↔ YYWW` pair swap, `^\d{4}$`-guarded, returns
input unchanged otherwise. Then:

- `toCanonicalDateCode(code)` — canonicalizes an enclave/label code
  (`dateCodeFormat === "wwyy"` → swap; `"yyww"` → identity). Applied at every
  **in** boundary below.
- `toLabelDateCode(code)` — inverse; applied at print/label **out** boundaries.

Both live in `src/db/dateCode.ts` (backend) with PDA/admin mirrors next to
their existing `dateCode.ts`/`wwyyDateCode.ts` helpers, all driven by the
resolved config (backend) or the `GET /config` value (PDA/admin).

## The receiving enclave (stays in label format)

- `receiving_orders.date_code`, `receiving_invoice_items.date_code` —
  written by upstream sync and receiving scans; displayed as-is on receiving
  pages. **Never converted.**
- Receiving scans (`parseQrRaw` / `parseScanText` / PDA `parseOcrScan.ts`)
  keep producing/consuming label-format codes — no conversion inside the
  parser; the output is *label format* by contract.
- Put-away scans match against receiving items (both enclave format) — no
  conversion in the put-away scan/match path itself.

## In boundaries (label/enclave format → canonical YYWW)

1. **Stock-lot creation** — the enclave→canonical boundary:
   - `src/db/putaway.ts:1077-1104` (confirm put-away): convert
     `item.dateCode` **before** the unique-lot lookup and the INSERT.
   - `src/db/putawayCn.ts:302` (CN put-away lot upsert): same.
   - `src/db/adhocPutaway.ts` (find-or-create lot): same. (Its
     `getTodayDateCode` currently builds YYWW while claiming WWYY — under
       this design YYWW is canonical, so unifying it onto the shared
       `dateToDateCode` helper both fixes the bug and keeps it canonical.)
2. **Picking scan** — `src/db/picking.ts` `scanPickingItem` (~1511): convert
   the body `scannedDateCode` before snapshot storage and before any
   batch-field matching; same conversion wherever the scanned label's batch
   fields are matched against lots (`resolveScannedShelfLot`,
   `require-match`/`require-any` paths).
3. **Goods-verify / measuring re-scans** — convert the scanned date code at
   the same points so scanned values compare equal to canonical lot/snapshot
   values.
4. **PDA scan pages that match against stock** (picking scan, goods verify,
   measuring, ad-hoc put-away): after `parseOcrScan` decode, canonicalize the
   scanned code (config from `GET /config`) before client-side compares
   (`usePickingScanQueue.checkDateCode`, `useScanMatchers`). Receiving /
   put-away detail pages do **not** convert (enclave).

## Out boundaries (canonical YYWW → label format)

5. **Label printing** — `src/db/scanParse.ts` `buildScanSegments` (:177) and
   `encodeKoaDateCodeRaw` (:200): the canonical `dateCode` is swapped to
   label format before KOA raw encoding. The admin QR-template preview
   (`apps/admin/utils/qrTemplate.ts`) decodes *labels* and stays label-format.
6. **Receiving display** — receiving order/item date codes render raw (enclave
   format, matching the physical invoice). Note for operators: receiving
   detail *allocation* cells join canonical lots and therefore show YYWW —
   called out in docs.

## Unchanged / re-oriented internals

- `src/db/dateCode.ts` — `dateCodeRank`/`dateToDateCode` re-oriented to YYWW
  (year = first pair); thresholds/outdated logic unchanged in structure.
- `src/db/stocksearch.ts` — `DC_RANK`/`DC_VALID` re-oriented to YYWW;
  date-range filters now string-range on YYWW; `DEFAULT_ORDER` plain
  lexicographic is now correct (kept, comment updated).
- `src/db/allocate.ts` — FIFO `ORDER BY il.date_code` is now chronologically
  correct; comment updated. `parseDateCodeRule` (YYMM, unwired) untouched.
- Outdated scan warnings, `dateCodeDisplayTemplate`, list templates, schema
  columns, ledger structure — unchanged.
- **Not migrated (historical, display-only):** `inventory_transactions` /
  `transaction_logs` batch snapshots, `outdated_scan_warnings`,
  `shelf_exchange` / `internal_transfer` audit copies. New rows are canonical;
  old rows remain label-format history.

## Data migration (per warehouse go-live)

Script (run once, in a maintenance window, after the deploy that ships the
conversion boundaries):

```sql
UPDATE inventory_lots    SET date_code = right(date_code,2) || left(date_code,2) WHERE date_code ~ '^\d{4}$';
UPDATE picking_packages  SET date_code = right(date_code,2) || left(date_code,2) WHERE date_code ~ '^\d{4}$';
UPDATE picking_packages  SET scanned_date_code = right(scanned_date_code,2) || left(scanned_date_code,2) WHERE scanned_date_code ~ '^\d{4}$';
```

`inventory_lots` and `picking_packages` are the only matching/FIFO-critical
tables. Swap is run exactly once; the boundary conversions guarantee every
new row is canonical, so the migration is not idempotent by design (re-running
would corrupt — guard with a checked precondition in the script).

**External dependency (out of repo):** the upstream sync service writes
`inventory_lots` directly (replication-role writes). It must be switched to
write canonical YYWW **before or with** the migration (receiving orders stay
WWYY — untouched). Coordinate with the sync service owner; the migration
script should verify zero WWYY-pattern lots arrive during the window.

Demo seed (`src/db/seed.ts`, `src/db/seed-shelves-*`, demo scenario
generator inputs) is updated to canonical YYWW so `db:seed` / `dev/reset`
produce a consistent world.

## Files touched

Backend: `src/db/dateCode.ts`, `src/db/scanParse.ts`, `src/db/putaway.ts`,
`src/db/putawayCn.ts`, `src/db/adhocPutaway.ts`, `src/db/picking.ts`,
`src/db/goodsverify.ts`, `src/db/stocksearch.ts`, `src/db/outdated.ts` (only
if rank call sites need reorientation), `src/config.ts`,
`src/routes/config.ts`, `src/routes/admin/flowEdits.ts` (config validation
lives in config.ts; check), seed files, plus a migration script under
`scripts/` (or a `db:` script).

PDA: `utils/dateCode.ts` (`dateToDateCode` → YYWW), `utils/wwyyDateCode.ts`
(rename semantics to canonical YYWW; rename file if cheap),
`utils/parseOcrScan.ts` (no change — output stays label format),
`composables/usePickingScanQueue.ts`, `composables/useScanMatchers.ts`,
`pages/stock-search/index.vue` (picker → canonical), ad-hoc put-away page
(shared helper), config type for `dateCodeFormat`.

Admin: `utils/dateCode.ts` (YYWW orientation), `utils/partStock.ts`
(lexicographic comment), `pages/flow-config.vue` (new field), `utils/qrTemplate.ts` (no change).

Docs: `docs/backend/schema-tables.md` / `api-design.md` date-code notes if
they assert WWYY, this spec, plan, and `docs/app-docs/` flow pages that
mention date-code format.

## Tests

- Backend: `dateCode.ts` unit tests (swap guards, rank orientation,
  canonical round-trip); put-away/putawayCn/adhocPutaway lot-write tests
  assert canonical YYWW stored from WWYY label input (with
  `dateCodeFormat=wwyy` default) and pass-through with `yyww`; picking scan
  scanned-snapshot conversion; stock-search ordering across a year boundary
  (e.g. wk52/2026 vs wk01/2027 sorts correctly).
- PDA: vitest for the canonicalize helper + matcher compare with config both
  ways.
- Existing suites: fixtures that insert literal WWYY codes
  (`'5221'`, `'2603'`, `dateToDateCode` callers) are reviewed — helpers flip
  to YYWW so most keep working.
