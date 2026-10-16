# KOA date-code month-counter periods (table-driven)

> NOTE (final): the design changed during implementation — the counter is a
> ROLLING 10→99 cycle (90 months), seeded as three forward rows anchored at
> 2010-12 / 2018-06 / 2025-12 (no backward rows). The spec
> `docs/superpowers/specs/2026-10-16-koa-date-code-periods-design.md` is
> authoritative; the "backward range" assumption below was superseded.

## Goal

Replace the hardcoded KOA counter anchor (`counter 17 = 2026-07`, linear) with a
DB table of counter periods, per the user's formula:

- Forward: counter 10 = 2025/12, +1/month … 94 = 2032/12
- Backward: counter 99 = 2025/11, −1/month … 71 = 2023/07
- One counter value ⇒ two candidate dates; pick the latest candidate **not in the
  future** relative to the scan date (user's example: today 2026-10-16, counter 54
  → 2029/08 rejected, 2022/02 picked ⇒ 2022).
- Rotation (every 5–6 years the counter restarts): managed **purely by inserting
  a new period row** (admin UI) — overlapping periods + the not-in-future rule
  disambiguate, old rows never need editing or deletion. No code change per
  rotation.

### Open assumption (flagged for user confirmation)

The user said "backward to 2016/1 = 71", but monthly steps from 99 = 2025/11 put
71 at **2023/07** (29 counters ≈ 29 months). Their own example (54 = 2022 or 2029)
confirms monthly stepping. Plan proceeds with monthly steps; because the mapping
is table data, correcting it later = updating one row, no code change. If 71
really maps to 2016/01, the backward range must step non-monthly and the user
needs to supply the real counter→date list.

### Semantics decision: digits 3–4 = day of month

`decodeKoaDateCode` exists in 3 divergent copies today: backend `scanParse.ts`
and PDA `parseOcrScan.ts` treat digits 3–4 as **day of month** (→ calendar date →
ISO week → WWYY); `new_seed/test-qr-templates.mjs` and the stale failing backend
tests treat them as a bare **week number**. Week contradicts the month counter
(counter 17 = July vs week 16 = April), so day-of-month is adopted everywhere and
the week-based copies/tests are rewritten. (This also resolves most of the
pre-existing test failures on this tree.)

## New table

`date_code_counter_periods` (in `apps/backend/src/db/schema/master.ts`, migration
via `db:generate`; generic `encoding` column so other suppliers' counter rules can
reuse it):

| column | type | notes |
|---|---|---|
| id | text PK | uuid v7 via `newId()` |
| encoding | text NOT NULL | `'koa_month_counter'` |
| direction | text NOT NULL | `'forward'` \| `'backward'` |
| counter_from | int NOT NULL | first counter of the run (backward: the high end, 99) |
| counter_to | int NOT NULL | inclusive last counter of the run (backward: the low end, 71) |
| period_start | date NOT NULL | first-of-month date that `counter_from` represents |
| created_date / last_update_date | timestamp | per schema conventions |

Seed (when table is empty, alongside other reference data in `src/db/seed.ts`):
- `forward, 10, 94, 2025-12-01`
- `backward, 99, 71, 2025-11-01`

## Decode algorithm (identical in all copies)

```
decodeKoaDateCode(raw, periods, referenceDate = now):
  digits = leading digit run of raw; need ≥ 4
  counter = digits[0..1], day = digits[2..3]  (day 1..31)
  candidates = periods where counter ∈ [min(from,to), max(from,to)]
      → date = period_start + offset months
         offset = forward ? counter - counter_from : counter_from - counter
  if no candidates → undefined
  ref = first day of referenceDate's month
  picked = max(candidates ≤ ref), else min(candidates)  (all in future)
  if day > daysInMonth(picked) → undefined
  date = picked + (day - 1) days → ISO week + ISO year → WWYY "WWYY"
```

`encodeKoaDateCodeRaw(dateCode, periods)` (label printing): find the period whose
month range contains the target year-month, invert the offset; `undefined` when no
period covers it.

## Backend changes (`apps/backend`)

1. `src/db/schema/master.ts` — table above; `db:generate` migration.
2. `src/db/seed.ts` — seed the two rows (reference-data seed path).
3. `src/db/dateCodePeriods.ts` (new) — `listDateCodePeriods(db)` + admin CRUD ops.
4. `src/db/scanParse.ts` — `decodeKoaDateCode(raw, periods, refDate?)`,
   `encodeKoaDateCodeRaw(dateCode, periods)`; `parseQrRaw(..., periods?)` and
   `buildKoaLabelRaw(..., periods?)` take an optional periods array (default:
   legacy single-anchor fallback so existing unit tests keep working? **No** —
   pass-through required; update call sites + tests instead).
5. `src/db/receiving.ts:314` — when the order's `dateCodeEncoding` is
   `koa_month_counter`, load periods once and pass to `parseQrRaw`.
6. `src/db/labels.ts` (`buildKoaLabelRaw` caller) — load periods, pass through.
7. `src/routes/scantemplates.ts` — new public `GET /date-code-periods` returning
   `[{encoding, direction, counterFrom, counterTo, periodStart}]` (read-only; used
   by the PDA parser and cache).
8. Admin CRUD `src/routes/admin/dateCodePeriods.ts` (list/create/update/delete
   under `/admin/date-code-periods`), registered in `src/routes/admin/index.ts`
   following an existing admin route module.

## Admin app (`apps/admin`)

9. `utils/entities.ts` — entity config for the new table (fields: encoding,
   direction select, counter_from/to numbers, period_start date); entry in
   `apps/admin/TOC.md`.
10. `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — `admin.entities.*` +
    `admin.fields.*` labels.

## PDA (`apps/pda`)

11. `services/types.ts` + `services/warehouse.ts` +
    `services/adapters/backendWarehouse.ts` — `getDateCodePeriods()` fetching
    `GET /date-code-periods` (cached like supplier templates).
12. `utils/parseOcrScan.ts` — same decode algorithm (keep-in-sync comment
    updated); `parseQrCapture`/`parseAndIdentify` take periods (optional for
    backward compat in tests).
13. `composables/useLabelScan.ts` — fetch periods alongside
    `getCachedSupplierQrTemplates` and pass into the parse calls. (Check other
    `parseQrCapture` callers — `useScanMatchers`, stock-search, put-away — and
    plumb the same cached periods.)

## Tests + verifier + docs

14. Backend: update `receiving.test.ts` (decodeKoaDateCode block → day-of-month +
    periods; "counter 17 = 2026-07" anchor test rewritten), `labels.test.ts`
    (round-trip with seeded periods), `scantemplates.test.ts` if touched. New unit
    tests: both periods, counter 54 @ ref 2026-10-16 → 2022; counter 54 @ ref
    2030-01 → 2029; overlap-pick-latest-past; day-overflow → undefined; backward
    counter 99 → 2025/11.
15. PDA: `tests/parseOcrScan.test.ts` decodeKoaDateCode block rewritten with
    periods; `services/adapters/backendWarehouse.test.ts` new-endpoint mapping.
16. `new_seed/test-qr-templates.mjs` — replace its week-based decode copy with the
    table semantics (seeded periods embedded); KOA assertions stay partNo/qty-only
    but `ok ex` output changes.
17. Spec: `docs/superpowers/specs/2026-10-16-koa-date-code-periods-design.md`;
    this plan at `docs/superpowers/plans/2026-10-16-koa-date-code-periods.md`.
18. `AGENTS.md` — update the `koa_month_counter` bullet (table-driven periods,
    not "counter 17 = 2026-07"); `docs/app-docs/ai/feature-registry.md` +
    relevant flow `ai-scope.md` per the documentation system.

## Verification

- `pnpm --filter @warehouse/backend build` and `test` (new + updated tests pass;
  pre-existing stale KOA/iC-Haus failures resolved where this work overlaps them).
- `pnpm --filter @warehouse/pda test` and `nuxt prepare`.
- `node new_seed/check-seed-templates.mjs` + `node new_seed/test-qr-templates.mjs`.
- Manual: dev backend + PDA, scan a KOA raw with counter 54 (`:RK73B1JTTD181G::163:X:5420Q156:S615:...`) on a receiving order — expect WWYY in 2022; admin page CRUD a period row and re-scan.
