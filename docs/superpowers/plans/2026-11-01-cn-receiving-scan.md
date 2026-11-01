# CN Receiving Scan Task — Implementation Plan

Date: 2026-11-01
Spec: `docs/superpowers/specs/2026-11-01-cn-receiving-scan-design.md`

1. **Schema** (`apps/backend/src/db/schema/receivingCn.ts`): add `scan_status`, `scan_qty`, `scan_reason`, `scan_note`, `scanned_by`, `scanned_at` to `receiving_invoice_items_cn`; update the status comment on `receiving_orders_cn` (`pending | scanning | in_hand | clear`). `db:generate` migration.
2. **Scan domain** (`apps/backend/src/db/receivingCnScan.ts`): `listCnScanTasks`, `getCnScanTaskDetail`, `scanCnItem` (ok / qty_mismatch warning, batch fields from the scan), `flagCnItem` (error + mismatch-column mirror), `resetCnItemScan`, `finalizeCnScanTask` (409 `unresolved_items` / `unresolvedAs:'missing'`; ok → `received_qty=scan_qty`, warning/error → 0; order → `in_hand`; conditional `put_away_tasks_cn` insert; audit + SSE).
3. **Reroute receipt moment** (`apps/backend/src/db/receivingCn.ts`): `startCnReceivingScanTx` replaces `receiveCnOrderTx` in `confirmCnOrder` and `finalizeCnOrder` — order → `scanning`, no received_qty fill, no task; SSE `receiving_cn.scan_started`.
4. **Routes** (`apps/backend/src/routes/receivingCn.ts`): `GET /receiving-cn/scan-tasks[/:id]`, `POST …/items/:itemId/scan|flag|reset`, `POST …/finalize` — all `cnReceiving()`-gated.
5. **Backend tests**: new `routes/receivingCnScan.test.ts`; update `routes/admin/receivingCn.test.ts`, `routes/receivingCn.test.ts`, `jobs/receivingCnSync.test.ts` for confirm/finalize → `scanning`.
6. **PDA** (`apps/pda`): service/adapter methods + DTOs; home tile; `pages/receiving-cn-scan/index.vue` list; `pages/receiving-cn-scan/[id].vue` scan/flag/finalize detail; i18n strings; vitest for the matching helper.
7. **Admin** (`apps/admin`): types in `utils/flowApi.ts`; `pages/receiving-cn/[batchNo].vue` scanning status + per-item scan outcome; `pages/receiving-cn/index.vue` status filter.
8. **Docs**: this spec/plan; `docs/app-docs/flows/` CN receiving docs + `ai/feature-registry.md` / `ai/code-map.md`; AGENTS.md CN paragraph.
9. **Verify**: `pnpm --filter @warehouse/backend test` + `build`; `pnpm --filter @warehouse/pda test` + `nuxt prepare`; admin typecheck; manual walkthrough admin-confirm → PDA scan → finalize → put-away contains only clean items.
