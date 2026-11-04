# CN Receiving Scan — Aggregate Group Matching — Implementation Plan

Date: 2026-11-04
Spec: `docs/superpowers/specs/2026-11-04-cn-receiving-scan-grouping-design.md`

## Backend (`apps/backend`)

1. `src/db/receivingCnScan.ts`:
   - Add `scanCnTaskAggregate(tx-ish, taskId, input, actorId)`: load task items → open-line candidates → part-key match (reuse/port the backend's existing normalized part-key convention) → batch-field filter (label field present ⇒ line NULL or normalized-equal, for dateCode/coo/cow) → 404 `no_matching_item` on empty → FIFO credit in `po_no, po_line, id` order (NULL `line_qty` lines last, absorb remainder) → per-line status (`ok` when covered, `warning`/`qty_mismatch` on over-scan or NULL-lineQty credit, partial stays open) → batch fields fill-only-if-null on credited lines → transaction_logs + SSE (same events/topics as `scanCnItem`) → return full task detail + `lastScan: { overQty }`.
   - Remove `scanCnItem` (replaced); keep `flagCnItem`, `resetCnItemScan` (verify reset also clears partial `scan_qty` → NULL).
   - `finalizeCnScanTask`: `received_qty = min(scan_qty, line_qty)` (`NULL` line_qty → scan_qty) for non-`error` lines with `scan_qty > 0`; `error` and untouched lines → 0. 409 while open lines remain, unchanged.
2. `src/routes/receivingCn.ts`: add `POST /receiving-cn/scan-tasks/:id/scan-aggregate` (`cnReceiving()`-gated, zod/validator consistent with existing routes); remove `POST …/items/:itemId/scan`.
3. Tests: rewrite/extend `test/routes/receivingCnScan.test.ts` — FIFO credit across lines, partial credit keeps line open, over-scan → warning + `overQty`, batch-field match/mismatch (incl. NULL line fields), no-match 404, NULL-lineQty absorb, flagged lines skipped, finalize partial-credit `received_qty` rule, group reset clearing partial scan_qty.
4. Docs: `docs/backend/api-design.md` (swap the per-item scan route for the aggregate one), `docs/backend/event-catalog.md` if event shapes change (reuse existing events if possible).

## PDA (`apps/pda`)

5. `utils/cnScanGroups.ts` (new): `buildCnScanGroups(items)` → stable-sorted groups keyed `partKey|dateCode|coo|cow` with summed `scanQty`/`lineQty`, member lines, derived status (`error`/`over`/`complete`/`partial`/open); + vitest coverage.
6. `services/types.ts` + `services/adapters/backendWarehouse.ts` (+ `WarehouseService` surface): `CnScanAggregateInput`, `scanCnTaskAggregate(taskId, input)` → `CnScanTaskDetail & { lastScan?: { overQty?: number } }`; remove `scanCnItem`.
7. `pages/receiving-cn-scan/[id].vue`: render groups; delete chooser modal + `findCnScanMatches` path; scan → aggregate endpoint → replace detail, toast over-received; group-level flag/reset looping existing per-item endpoints; header progress in quantities.
8. i18n: update `receivingScan.*` in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` (drop chooser keys, add group/over-received keys).
9. Update/remove `utils/cnReceivingScan.ts` + its tests as needed (matching moved server-side).
10. Docs: `docs/app-docs/flows/` CN receiving flow files (overview/steps/ai-scope) + `ai/feature-registry.md` / `ai/code-map.md` if files were added/removed.

## Verify

11. `docker compose up -d`; `pnpm --filter @warehouse/backend test` + `build`; `pnpm --filter @warehouse/pda test` + `nuxt prepare` + `build`.
12. Manual: seeded CN order with duplicate-part lines → PDA scan page shows grouped rows → scan labels → totals accumulate, no chooser → finalize with a shortfall → put-away contains credited quantities.
