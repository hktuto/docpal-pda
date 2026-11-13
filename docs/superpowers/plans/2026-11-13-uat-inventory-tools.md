# UAT inventory tools — implementation plan

Date: 2026-11-13. Spec: `docs/superpowers/specs/2026-11-13-uat-inventory-tools-design.md`.
Branch: `feat/uat-inventory-tools`.

> Update (same day): the `UAT_TOOLS` env gate from the original plan was
> dropped per user request — the wipe route/button is always available
> (admin-group middleware + type-"DELETE" confirm dialog only) and must be
> removed manually after UAT. Steps below reflect the shipped state.

## Backend

1. `src/routes/admin/uatInventoryWipe.ts` (new) — `POST /` single-tx wipe
   per spec §2 (sync_events_off, allocations → lot_sources →
   goods_verify_tasks NULL → txns → logs → lots, audit row,
   `{ ok, deletedLots }`).
2. `src/routes/admin/shelfInventoryImport.ts` (new) —
   `GET /org-options?shelfCode=` (scope-filtered org_info pairs) and
   `POST /` (scope validation → per-row part lookup → lot upsert/merge →
   ADJUST ledger rows → import transaction_logs row; per-row errors, good
   rows commit).
3. `src/routes/admin/index.ts` — mount `/shelves/import-inventory` and
   `/uat/inventory-wipe` unconditionally (wipe is admin-gated by the
   existing middleware; no env flag).

## Tests (node:test, pattern of orderReset.test.ts)

- `uatInventoryTools.test.ts` — Import: happy path (lot + ADJUST txn + log
  row), second import merges, unknown wcl_item_no per-row error with valid
  row committing, out-of-scope pair → 422, org-options scope filtering.
  Wipe: seed lot + allocation + goods_verify_tasks pointer → wipe → all
  four tables empty + only the wipe audit log remains + task kept with
  NULL lot id.

## Admin UI

4. `utils/flowApi.ts` — `ShelfOrgOptions` / `ShelfInventoryImportPayload` /
   `ShelfInventoryImportResult` types + `shelfOrgOptions`,
   `importShelfInventory`, `uatInventoryWipe` methods.
5. `components/ShelfInventoryImportDialog.vue` (new) — org pair
   SearchableSelect (single) + hidden file input; xlsx → header-indexed
   rows → client validation → POST; per-row errors + inserted/merged banner.
6. `pages/shelves.vue` — row-actions "Import" button + dialog, table reload
   on saved.
7. `pages/stock-search.vue` — red wipe button in `.page-head`, always
   rendered for admins; type-"DELETE" confirm dialog; success banner with
   deleted count + summary reload.

## i18n / docs / template

8. `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — `stockSearch.wipe*`
   and `admin.shelves.importInventory.*` keys.
9. `docs/uat/functions.json` — ADM-042 (shelf import), ADM-043 (UAT wipe);
   `node scripts/gen-uat-xlsx.mjs`.
10. `docs/app-docs/ai/feature-registry.md` (+ code-map.md) — two new entries.
11. `scripts/gen-inventory-import-template.mjs` →
    `supporting_doc/inventory-import-template.xlsx` (header + 3 example rows,
    frozen/bold header, Instructions sheet).

## Verification

- `pnpm --filter @warehouse/backend build` (tsc)
- `pnpm --filter @warehouse/backend test` (needs the shared Postgres —
  `docker compose up -d` if not running)
- `pnpm --filter @warehouse/pda exec nuxt prepare`
- `pnpm --filter @warehouse/admin build`
- regenerated UAT xlsx + template xlsx exist.
