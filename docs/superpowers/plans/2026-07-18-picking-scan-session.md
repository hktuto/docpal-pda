# Picking scan session — implementation plan

Spec: `docs/superpowers/specs/2026-07-18-picking-scan-session-design.md`

1. **Queue composable** `apps/web/composables/usePickingScanQueue.ts`
   - State: `rows` (`{key, itemId, allocationId, partNo, qty, dateCode, lotCode, coo, cow, raw, source, status: 'queued'|'applied'|'failed', error?}`).
   - `addScan(parsed: OcrInput, raw: string)` → `{ok} | {ok:false, message}`:
     reject when raw already queued; find order item by normalized partNo;
     pick first allocation with `qty ≤ remaining` where
     `remaining = allocation.qty − queued qty against that allocation`;
     append row.
   - `removeRow(key)`, `reset()`.
   - `applyAll(scanFn)`: sequentially call `scanFn(row)` for queued rows;
     mark `applied`/`failed` per row; return counts.
   - Init input: the `PickingOrderDetail` items+allocations.
2. **Unit tests** `apps/web/composables/usePickingScanQueue.test.ts` (vitest):
   match, ambiguous-part-two-items picks first fitting allocation,
   cumulative qty across queued rows, duplicate raw rejected, no-allocation
   rejected, applyAll partial failure marks rows.
3. **Session page** `apps/web/pages/picking/scan/[id].vue`
   - Load order via `warehouse.getPickingOrder(id)`.
   - `useHardwareScanner` armed here (removed from detail page): onScan →
     `parseRawValue` → `ocrResultToInput` → `addScan` → toast success/error.
   - OCR button → `captureLabel()` → `processCapture`-style parse without
     applying: reuse `parseRawValue` for QR-only captures and
     `parseAndIdentify` for OCR text (mirror the branch in `useLabelScan.processCapture`).
   - Checkout table (newest first): #, partNo, qty, lot/date/coo/cow, source
     badge, status/error, remove button. Per-item progress summary on top:
     required / server-scanned / queued.
   - Confirm button (disabled when no queued rows or applying): `applyAll`
     with `warehouse.scanPickingItem(itemId, {allocationId, qty, dateCode, lotCode, coo, cow})`;
     all applied → toast + navigate back; else keep failed rows.
   - Leave guard: `onBeforeRouteLeave` + `beforeunload` when queued rows exist.
   - Back navigation: `from=receiving&ro=<id>` query → `/receiving/<ro>?tab=picking`,
     else `/picking/<id>`.
4. **Picking detail cleanup** `apps/web/pages/picking/[id].vue`
   - Remove: `useHardwareScanner` block, `useLabelScanReview`, review modal,
     `openScan`, `onRetake`, `scanTarget`, `scanContext`,
     `findMatchingAllocation`, `onAppliedWithScroll` (plain `load` for boxes ops).
   - Add header action: Scan button → `/picking/${orderId}/scan`
     (only when `actionable`).
   - `PickingItemsSection.vue`: remove `scanning` prop and `@scan` emit +
     per-item scan button.
5. **Receiving picking tab** `apps/web/components/receiving/ReceivingPickingTab.vue`
   + parent `apps/web/pages/receiving/[id].vue`
   - Add "Scan" button per picking order card (next to Create box) →
     `router.push('/picking/' + po.id + '/scan?from=receiving&ro=' + orderId)`.
6. **i18n** `apps/web/i18n/locales/{en-US,zh-CN,zh-HK}.ts`: `picking.scanSession.*`
   (title, queuedRows, confirm, confirmPartialFail, leaveWarning, ocrCapture,
   requiredScannedQueued, duplicateScan, noMatchingAllocation, removeRow, emptyQueue).
7. **Verify**: `pnpm --filter @warehouse/web nuxt prepare`,
   `pnpm --filter @warehouse/web test`, manual browser pass through
   picking detail → scan session → confirm, and receiving picking tab entry.
8. **Docs**: update `docs/app-docs/flows/picking/ai-scope.md`,
   `docs/app-docs/ai/code-map.md`, `docs/app-docs/ai/feature-registry.md`.
