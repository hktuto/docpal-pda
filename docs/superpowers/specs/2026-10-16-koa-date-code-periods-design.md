# KOA date-code month-counter periods — design

Date: 2026-10-16
Status: implemented

## Problem

KOA reel labels encode the lot date as a 2-digit month counter + 2-digit day
(`1625H713`). The old decoder hardcoded a linear anchor (counter 17 = 2026-07),
which cannot represent:

- the real scheme: the counter **rolls 10→99 and restarts** — a 90-month cycle
  (user-confirmed anchors: 10 = 2025/12; previous cycle 10 = 2018/06 … 99 =
  2025/11; before that 10 = 2010/12 … 99 = 2018/05);
- rotation: every ~5–7 years the counter wraps, so any hardcoded anchor goes
  stale;
- ambiguity: the same counter value appears once per cycle, so a scanned value
  maps to several candidate dates and the decoder must pick the right one.

## Decision

Table-driven periods, one row per rolling cycle, plus a not-in-the-future
disambiguation rule. No code change is ever needed for a rotation — an admin
inserts the next cycle's row.

### Table `date_code_counter_periods`

| column | meaning |
|---|---|
| id | text PK (uuid v7) |
| encoding | decoding rule, e.g. `koa_month_counter` |
| direction | `forward` (+1 month per counter step) — seeded rows are all forward; `backward` kept for future encodings |
| counter_from / counter_to | inclusive counter range of the run |
| period_start | `YYYY-MM-DD` (first of month) that `counter_from` represents |

Seed (per warehouse, in `src/db/seed.ts`):

- `forward, 10, 99, 2010-12-01` (covers 2010/12 … 2018/05)
- `forward, 10, 99, 2018-06-01` (2018/06 … 2025/11)
- `forward, 10, 99, 2025-12-01` (2025/12 … 2033/05)

### Decode algorithm (canonical copy: `apps/backend/src/db/scanParse.ts` `decodeKoaDateCode`)

1. Leading digit run ≥ 4 digits; counter = digits 1–2, day = digits 3–4
   (day of month — **not** a week number; week contradicts the month counter).
2. Every period whose inclusive counter range contains the counter contributes
   a candidate month: `period_start + offset months`, `offset = counter −
   counter_from` (forward) or `counter_from − counter` (backward).
3. No candidates → `undefined` (unknown counter).
4. Pick the **latest candidate whose month ≤ the scan-date month**; if all are
   in the future, pick the earliest. This resolves rotation ambiguity to the
   most recent past label (e.g. counter 54 scanned 2026-10 → candidates
   2014-08 / 2022-02 / 2029-08 → **2022-02**).
5. Day must fit the picked month; the date converts to ISO-8601 week + ISO
   week-year → WWYY (e.g. 2022-02-20 → `0722`).

`encodeKoaDateCodeRaw` (label printing) inverts via the period covering the
target month.

### API

- `GET /date-code-periods` (public, read-only) — `[
  {encoding, direction, counterFrom, counterTo, periodStart}]`; consumed by the
  PDA client-side parser (cached next to `/scan-templates` in
  `useLabelScan.ts`) and the admin QR-template preview.
- `/admin/date-code-periods` — generic admin CRUD (`createCrudRouter`);
  admin UI entity "Date Code Counter Periods" under Supplier Management.
- Request paths pass the DB rows into the parser: `scanReceivingOrder`
  (`receiving.ts`) and `getLabelsData` (`labels.ts`).

### Rotation management (the "how do we update it" answer)

When KOA wraps the counter (next wrap: 99 = 2033/05 → 10 = 2033/06), an admin
adds ONE row: `forward, 10, 99, 2033-06-01`. Overlap with older rows is fine —
the not-in-future rule keeps decoding historical labels correctly. Old rows are
never edited or deleted. `DEFAULT_KOA_PERIODS` in `scanParse.ts` (and the PDA /
admin / verifier copies) embeds the three seed cycles as an offline fallback;
requests always use the DB rows.

## Copies to keep in sync

- Backend canonical: `apps/backend/src/db/scanParse.ts`
- PDA: `apps/pda/utils/parseOcrScan.ts` (+ service `getDateCodePeriods`)
- Admin preview: `apps/admin/utils/qrTemplate.ts`
- Verifier: `new_seed/test-qr-templates.mjs`

## Out of scope / notes

- The WWYY result feeds the outdated-date-code warning unchanged.
- Backward-direction rows exist in the schema for future encodings; the seeded
  KOA cycles are all forward.
