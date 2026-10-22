# Date-code format config — YYWW canonical — implementation plan

> NOTE (final): implementation findings that supersede details below —
> 1. The print OUT boundary is `buildKoaLabelRaw` (there is no
>    `buildScanSegments`); it takes a `dateCodeFormat` input and applies
>    `toLabelDateCode` before `encodeKoaDateCodeRaw` (`labels.ts` canonicalizes
>    receiving-source codes first — an involution round-trip — so receiving
>    labels keep printing their own enclave code).
> 2. `getTodayDateCode` lives in the PDA ad-hoc put-away page, not the backend;
>    it was replaced by `toLabelDateCode(dateToDateCode(new Date()), format)`.
> 3. `goodsverify.ts` has no scanned-vs-lot matching — task 10 was a no-op;
>    measuring/verify matching is client-side aggregate (string equality on
>    scanned snapshots), safe by design.
> 4. Two unplanned IN boundaries were converted: `removeScanFromBox` (put-away
>    reversal lot lookup) and `previewShelfExchange`.
> 5. **Wire convention:** clients keep POSTing label-format date codes
>    (scanned values are label format by contract); the backend canonicalizes
>    at every body boundary (`picking.ts` scanPickingItem, `adhocPutaway.ts`,
>    `shelfExchange.ts` preview). Client-side compares canonicalize at compare
>    time only — converting before posting would double-swap.
> 6. `apps/pda/utils/wwyyDateCode.ts` was deleted; its functions moved into
>    `apps/pda/utils/dateCode.ts` (canonical YYWW orientation).
> 7. One-time migration script: `scripts/migrate-datecode-yyww.mjs`
>    (run-once marker in `warehouse_config`, NOT idempotent).

Spec: `docs/superpowers/specs/2026-10-22-datecode-format-config-design.md` (authoritative).

## Goal

Make YYWW the canonical stored date-code format everywhere downstream of
receiving; keep the receiving flow (upstream-synced orders + supplier label
scans) in the label format; one flow-config key `dateCodeFormat`
(`"wwyy"` default | `"yyww"`) describes the label/upstream format; convert at
the enclave boundaries.

## Phase 1 — Backend core (config + helpers + SQL orientation)

1. `apps/backend/src/db/dateCode.ts`
   - Re-orient `dateCodeRank` to YYWW: year = `slice(0,2)`, week = `slice(2,4)`
     (keep the 2-digit-year window logic).
   - `dateToDateCode` emits `${yy}${week}` (YYWW).
   - Add `swapDateCode(code)` — guarded `^\d{4}$` pair swap, else input
     unchanged; `toCanonicalDateCode(code, format)` and
     `toLabelDateCode(code, format)` where `format` is the resolved
     `dateCodeFormat`.
2. `apps/backend/src/config.ts` — add `dateCodeFormat: "wwyy" | "yyww"` to the
   flow-config interface (default `"wwyy"`), validation branch in
   `mergeFlowConfigJson` (reject other values), getter following the
   `pickingShelfScan` getter pattern, `_setDateCodeFormatForTests` helper.
3. `apps/backend/src/routes/config.ts` — include `dateCodeFormat` in the
   `GET /config` payload.
4. `apps/backend/src/db/stocksearch.ts` — re-orient `DC_RANK`/`DC_VALID` to
   YYWW (`left` = year, `right` = week); date-range filters become plain
   YYWW string range compares (drop rank indirection where it only served
   WWYY ordering); keep `DEFAULT_ORDER` lexicographic (now correct), update
   comments.
5. Unit tests for 1–4: rank orientation (wk52/2026 vs wk01/2027), swap guards,
   config validation (bad value rejected, default), stock-search ordering
   across a year boundary.

Verify: `pnpm --filter @warehouse/backend build` + new/affected unit tests pass.

## Phase 2 — Backend boundaries

6. Lot creation (convert enclave → canonical **before** unique-lot lookup and
   insert):
   - `src/db/putaway.ts` (~1073-1104) — `toCanonicalDateCode(item.dateCode)`.
   - `src/db/putawayCn.ts` (~279-310) — same for the upsert key + insert.
   - `src/db/adhocPutaway.ts` — same; replace its local
     `getTodayDateCode` with the shared `dateToDateCode` (now YYWW — fixes the
     inverted-code bug at the PDA mirror too, see Phase 3).
7. Picking scan: `src/db/picking.ts` `scanPickingItem` (~1511) — canonicalize
   `input.scannedDateCode` before snapshot store; canonicalize scanned label
   batch fields before lot matching in `resolveScannedShelfLot` and the
   require-* paths. Audit `src/db/goodsverify.ts` and measuring/verify routes
   for the same scanned-vs-lot comparisons and canonicalize there.
8. Print out: `src/db/scanParse.ts` `buildScanSegments`/`encodeKoaDateCodeRaw`
   — swap canonical → label format before KOA raw encoding
   (`toLabelDateCode`); thread the resolved format through (callers in
   labels/print paths).
9. Do NOT touch: `parseScanText`/`parseQrRaw` decode output (stays label
   format — enclave contract), receiving routes' storage of item date codes.

Verify: backend build + put-away/picking/goodsverify test suites pass with
new assertions: WWYY-labelled input stores canonical YYWW lots (default
config); `_setDateCodeFormatForTests("yyww")` pass-through case.

## Phase 3 — PDA

10. `apps/pda/utils/dateCode.ts` — `dateToDateCode` emits YYWW (canonical);
    keep/rename `utils/wwyyDateCode.ts` semantics to canonical YYWW
    (`parseWwyy` → parse YYWW: year first pair, week second; week 01-53
    guard now rejects likely-WWYY instead).
11. Canonicalize scanned codes post-decode on stock-matching pages only:
    picking scan (`usePickingScanQueue.checkDateCode`, `useScanMatchers`),
    goods verify / measuring matchers, ad-hoc put-away (also switch its
    today-code to the shared helper). Receiving + put-away detail pages:
    no conversion. Config value comes from `GET /config` (extend the
    client-side config type).
12. `pages/stock-search/index.vue` — date pickers convert calendar →
    canonical YYWW (already flow through `dateCode.ts`; verify no WWYY
    assumption remains).

Verify: `pnpm --filter @warehouse/pda test` + `nuxt prepare`.

## Phase 4 — Admin

13. `apps/admin/utils/dateCode.ts` — YYWW orientation (`dateCodeRank`,
    `dateToDateCode`, range helpers); `utils/partStock.ts` lexicographic
    comment update (now genuinely correct across years).
14. `apps/admin/pages/flow-config.vue` — `dateCodeFormat` select
    (wwyy/yyww), wired through `utils/flowApi.ts` types.
15. `apps/admin/utils/qrTemplate.ts` — no change (decodes physical labels,
    stays label format); verify no canonical assumption sneaks in.

Verify: admin build/typecheck (`pnpm --filter @warehouse/admin build` if
available, else nuxt prepare) + manual flow-config round trip against a
running backend.

## Phase 5 — Seed, migration, docs

16. Demo seed (`src/db/seed.ts` and any seed helpers generating date codes)
    emits canonical YYWW so `db:seed`/`dev/reset` stay consistent; review
    backend test fixtures with literal WWYY codes (`'5221'`, `'2603'`, …)
    and update to canonical YYWW where they feed lot/package rows.
17. Migration script `scripts/migrate-datecode-yyww.mjs` (one-time, guarded):
    the three swap UPDATEs from the spec (inventory_lots, picking_packages
    date_code + scanned_date_code), with a precondition check + explicit
    "run once, not idempotent" warning; verify zero `\d{4}` WWYY-pattern
    arrivals guidance for the sync service.
18. Docs: update WWYY assertions in `docs/backend/schema-tables.md` /
    `api-design.md` if present; `docs/app-docs/` receiving/picking/stock
    pages mentioning date-code format; `AGENTS.md` date-code bullet.

Verify: full backend test suite, PDA suite, `nuxt prepare` for pda+admin,
manual smoke: seed demo → receiving scan (WWYY label) → put-away → lot row
canonical YYWW → stock search sorts wk52'26 before wk01'27 → picking scan
WWYY label matches → print label round-trips.

## Sequencing notes

- Phases 1→2 are one backend branch-commit unit; 3 and 4 are independent and
  can follow in parallel subagent work; 5 last.
- The config defaults to `"wwyy"` — until the HK migration runs, existing
  prod lots remain WWYY; sorting there stays no worse than today (same
  lexicographic behavior), so deploy does not have to be synchronous with the
  migration window.
