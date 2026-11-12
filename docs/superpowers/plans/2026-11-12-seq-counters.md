# Sequence counters (custom label weekly serial) — implementation plan

Design agreed in chat 2026-11-12 (no separate spec doc; summary below — promote to `docs/superpowers/specs/` if the feature grows).

**Design summary.** A keyed `seq_counters` table issues atomic, gap-free integer blocks for label serials (first consumer: the admin custom-label CSV converter's `REEL NO` serial, ~178 labels per conversion). Reset is **lazy** — computed on each request, no cron. Reset policy is a `reset_schedule` + `reset_interval` pair: `weekly` (interval = weekday 1–7, 1=Mon), `monthly` (interval = day of month 1–28), `days` (interval = N≥1 days since last reset), `never` (interval NULL). The API returns raw integers; 6-digit zero-padding and REEL NO assembly stay in the label converter. Unknown keys 404 (rows are seeded, never auto-created). No wrap at 999999 — a 7-digit serial beats a duplicate REEL NO.

1. Schema (`apps/backend/src/db/schema/master.ts`)
   - Add `seqCounters` table: `id` text PK (uuid v7), `key` text unique notNull, `value` integer notNull default 0, `reset_schedule` text notNull default `'never'`, `reset_interval` integer null, `last_reset_on` date null, `created_date`/`last_update_date` per convention.
   - `pnpm --filter @warehouse/backend db:generate` → migration.
2. Domain (`apps/backend/src/db/sequences.ts`)
   - `periodStartFor(schedule, interval, today): Date | null` — pure, DB-free boundary math per schedule type (weekly: most recent weekday; monthly: this month's day if reached else previous month's; days: today − ((today − last_reset) mod N) handled against `last_reset_on`; never: null). Exported for unit tests.
   - `nextSeqValues(db, key, count): { start, count }` — single tx: `SELECT … FOR UPDATE` by key (missing → throw `unknown_seq_key` 404), lazy reset if `periodStartFor(...) > last_reset_on` (zero value, stamp `last_reset_on`), `value += count`, update row, return `start = oldValue + 1`.
3. Route (`apps/backend/src/routes/admin/sequences.ts` + register in `routes/admin/index.ts`)
   - `POST /admin/sequences/next` — body `{ key: string, count: int }`; 400 `invalid_payload` on bad key type / count < 1 / count > 10000; 404 `unknown_seq_key`; response `{ key, start, count }`. Admin-gated like all `/admin/*`.
4. Seed (`apps/backend/src/db/seed.ts`)
   - Seed one row in reference seeding: `custom_label_weekly_serial`, `reset_schedule = 'weekly'`, `reset_interval = 1` (Monday), `value = 0`.
5. Backend tests
   - `src/db/sequences.test.ts` — pure-function tests for `periodStartFor` across all four schedule types (weekday today/not-yet-this-week, month boundary, N-day elapsed/not-elapsed, never).
   - `src/routes/admin/sequences.test.ts` — first issue starts at 1, increments across calls, block allocation is contiguous, lazy Monday rollover (insert row with old `last_reset_on`, assert restart at 1 and stamped reset date), `never` never resets, unknown key 404, validation 400s.
6. Admin helper (`apps/admin/utils/customLabelCsv.ts`)
   - `nextSeqValues(key, count)` via `useApi()`; wire the CSV converter's REEL NO serial to it (zero-pad to 6 digits client-side) — separate commit from the backend if the converter change isn't in scope yet.
7. Docs
   - `docs/backend/api-design.md` — catalog row for `POST /admin/sequences/next`.
8. Verify + commit
   - `pnpm --filter @warehouse/backend build && pnpm --filter @warehouse/backend test`; `node scripts/gen-uat-xlsx.mjs` only if a UAT function entry is added (likely not — internal API); commit.
