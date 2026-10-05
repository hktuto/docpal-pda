# Put-away: scan box QR / shelf QR — implementation plan

Spec: `docs/superpowers/specs/2026-10-05-put-away-scan-box-shelf-design.md`.

1. `apps/pda/utils/putAwayScan.ts` — add `classifyPutAwayScan(raw, shelves, boxes)`:
   `{type:"shelf",code}` | `{type:"box",boxId,existing}` | `{type:"item"}`.
2. `apps/pda/tests/putAwayScan.test.ts` — unit tests for the classifier.
3. `apps/pda/pages/put-away/[id].vue`:
   - state `selectedShelf: string | null`; banner (dismissible) above the items panel.
   - `useHardwareScanner.onScan`: run classifier first (skip when scan-box dialog is
     open — that dialog keeps capturing the raw value as the box id).
   - shelf branch: set `selectedShelf`, toast.
   - box branch: existing+open → `activeBoxId`; existing+not open → error toast;
     unknown → `selectedShelf ? createShelfBox(orderId, selectedShelf, boxId)+activate
     : openScanBoxDialog(prefill boxId)`.
   - `openNewBoxDialog`: when `selectedShelf` set, create directly (skip dialog).
   - `openScanBoxDialog`: pass `selectedShelf` as the dialog's initial shelf.
4. `apps/pda/components/put-away/ScanBoxDialog.vue`: accept `initialShelfCode` prop to
   pre-select the shelf.
5. i18n: new keys in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` under `putAway`.
6. Verify: `pnpm --filter @warehouse/pda test`, `nuxt prepare`, browser scan-emulation
   on `localhost:3103` (keyboard-wedge replay) for shelf scan → box scan → item scan.
7. Docs: update `docs/app-docs/flows/put-away/{overview,steps,ai-scope}.md` and
   `docs/backend/api-design.md` put-away note if needed (no API change — likely none).
