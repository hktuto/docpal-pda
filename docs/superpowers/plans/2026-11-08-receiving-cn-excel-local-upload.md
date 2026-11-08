# CN receiving — local Excel upload — implementation plan

Spec: `docs/superpowers/specs/2026-11-08-receiving-cn-excel-local-upload-design.md`

1. Backend domain (`apps/backend/src/db/receivingCn.ts`)
   - `createCnExcelUploads(db, { files, actor })`: one tx, per file order(pending)+invoice+items+tracking row+logs+SSE; reuse `validateCnPayload` (route side), `nextCnBrandedNo`, `deriveCnManualOrgSub`, `resolvePartByKey`. Export entry types.
2. Backend route (`apps/backend/src/routes/admin/receivingCn.ts`)
   - `POST /receiving-cn/excel` → JSON `{files:[{filename,brand,payload}]}` → 201 `{orders:[{id,batchNo}]}`; replace the multipart/DocPal handler; update comments.
3. Backend tests (`apps/backend/src/routes/admin/receivingCn.test.ts`)
   - Replace the 7 old excel tests: validation (empty files, bad payload, bad/missing brand), happy path row-shape assertions (pending order, delivery_date from sheet, org/sub from 訂單號 prefix, line_qty/received_qty, tracking row completed + no DocPal calls), multi-file same-brand sequence, multi-訂單號 grouping, created order flows through `confirm` → `scanning`.
4. Admin API (`apps/admin/utils/flowApi.ts`)
   - `submitCnExcelUpload(entries)` → JSON POST (replaces old multipart helper removed in `f9eab952`).
5. Admin UI
   - `pages/receiving-cn/new.vue`: classify picked files (pdf/excel/mixed), decode excels, step-2 stacked review, submit.
   - `components/receiving-cn/CnExcelDraftEditor.vue`: per-file review section (header form + brand input + editable items table via `useAdminTable`/`DataTable` + `ReceivingCnPartNoSelect` + totals cross-check + remove) — lifted from `git show f9eab952^:apps/admin/pages/receiving-cn/new.vue` step 2.
6. i18n (`layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`)
   - Broaden `uploadHint`/`dropHint`/`pickFile`/`invalidFileType` wording; add `fields.brand` + mixed-files + create-done keys.
7. Docs + tracking
   - `docs/backend/api-design.md` excel row; AGENTS upstream-sync clause; UAT `docs/uat/features/CR-*.json` + regenerate xlsx; `docs/app-docs` CN flow files if present.
8. Verify: `pnpm --filter @warehouse/backend test` + build, `pnpm --filter @warehouse/pda/admin`-side typecheck/tests, `node scripts/gen-uat-xlsx.mjs`, commit.
