# Auto Labeling Machine — Implementation Plan

Spec: `docs/superpowers/specs/2026-11-12-auto-labeling-machine-design.md`

## Backend

1. **Schema** — new `src/db/schema/auto-labeling.ts` with `auto_labeling_jobs`
   (id, picking_order_id FK, machine_id, payload/order_snapshot/scan_snapshot
   jsonb, status CHECK, status_note, created_by, fetched/completed dates,
   created/last_update) + status check; export from `schema/index.ts`.
   `label_print_rules.label_source` CHECK gains `auto_machine`
   (`schema/label-print.ts`), then `db:generate`.
2. **Domain** — new `src/db/autoLabeling.ts`:
   - `createAutoLabelingJob(db, { orderId, ruleId, actorId, scope })` —
     re-resolve rules (same validation as `printOrderLabel`: 404
     `label_print_rule_not_found`, 409 `label_print_rule_inactive` /
     `label_rule_no_longer_matches`), require `labelSource === 'auto_machine'`
     (409 `label_rule_not_auto_machine`), build the converted label rows
     (`buildLinkedLabelPrintParams`), build `order_snapshot` (orderNo, poNo,
     customer, brand list, …) and `scan_snapshot` (per-package part/qty +
     `scanned_*` fields), insert `pending` row, return `{ id, status, labelCount }`.
   - `fetchAutoLabelingJob(db, { machineId, jobId })` — with `jobId`: re-claim a
     known `printing`/`failed` job (idempotent). Otherwise newest `pending`
     (machine_id = machineId or NULL) → status `printing`, `fetched_date`.
     404 `auto_labeling_no_pending_job`.
   - `reportAutoLabelingJob(db, { id, status, note })` — `printing` →
     `completed`/`failed` (also `failed` → `failed` note update); stamps
     `completed_date` + `last_update_date`. 404 `auto_labeling_job_not_found`,
     409 `auto_labeling_job_state`.
3. **Auth** — `auth/middleware.ts`: when the path starts with `/auto-labeling`
   and the bearer token equals `MACHINE_API_TOKEN` (env), pass through without
   a JWT. Unset env → fail closed (fall through to 401).
4. **Routes** — new `src/routes/autoLabeling.ts`:
   - `POST /auto-labeling/jobs/fetch` (body `{ machineId?, jobId? }`)
   - `PATCH /auto-labeling/jobs/:id` (body `{ status, note? }`)
   Mounted in `src/index.ts`. Machine endpoints never use `actorFrom`.
5. **Picking wiring** (`src/db/labelPrintParams.ts`, `src/routes/picking.ts`):
   - `printOrderLabel` rejects `auto_machine` rules (409
     `label_rule_auto_machine`), same place as `external`.
   - `POST /picking-orders/:id/auto-labeling-job` (body `{ ruleId }`) →
     `createAutoLabelingJob`; `GET /picking-orders/:id/auto-labeling-job` →
     latest job for the order (status display on the PDA detail).
6. **Admin validation** — `routes/admin/crud.ts` `LABEL_SOURCES` adds
   `auto_machine`.
7. **Env docs** — `MACHINE_API_TOKEN` in `.env.example` +
   `docker-compose.prod.yml`; `docs/backend/label-printing.md` updated.

## Backend tests

New `src/db/autoLabeling.test.ts` (node:test, same setup/reseed pattern):
- create → pending row with payload/order/scan snapshots; non-auto rule → 409.
- fetch marks `printing` and returns payload; no pending → 404; jobId re-claim
  is idempotent.
- report `completed` / `failed`; illegal transition → 409.
- machine-token middleware check (route-level: valid token passes, missing env
  → 401).

## PDA

8. `services/types.ts` — `LabelPrintRuleMatch.labelSource` union adds
   `auto_machine`; new auto-job types.
9. `services/adapters/backendWarehouse.ts` — `createAutoLabelingJob(orderId,
   ruleId)`, `getAutoLabelingJob(orderId)`.
10. `components/picking/LabelPrintRulesPanel.vue` — `auto_machine` rows show an
    "auto label" button → creates the job, row state `submitted`, then a
    load-material hint (i18n) appears; excluded from the printer picker,
    included in "print all". Reuse existing row-state machinery
    (`stateOf`, `reset`).
11. i18n keys (en-US / zh-CN / zh-HK) under `picking.printLabels.*`.

## Verification

- `pnpm --filter @warehouse/backend build` + `test`
- `pnpm --filter @warehouse/pda test` + `nuxt prepare`
- Migration generated; manual browser check of the picking-finish prompt with
  an `auto_machine` rule (create job → load-material hint; machine fetch +
  report via curl with the token).
