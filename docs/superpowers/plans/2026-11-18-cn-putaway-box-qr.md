# Plan — CN put-away carton-QR box dialog (2026-11-18)

Spec: `docs/superpowers/specs/2026-11-18-cn-putaway-box-qr-design.md`

## Steps

1. **Backend** `apps/backend/src/db/putawayCn.ts`
   - Add `ri.invoice_no AS "invoiceNo"` to the CN task-detail item query and
     `invoiceNo: string` to `CnPutAwayItemRow`. Update
     `putawayCn.test.ts` if it pins the row shape.
2. **PDA types + adapter**
   - `services/types.ts`: `PutAwayExpectedItem.invoiceNo?: string | null`
     (CN-only optional, same pattern as `poNo`/`poLine`).
   - `services/adapters/backendWarehouse.ts`: add `invoiceNo` to
     `CnPutAwayItemRaw` and the normalized items map in
     `getCnPutAwayTaskDetail`.
3. **Parser** `apps/pda/utils/cnBoxQr.ts` (new, pure)
   - `parseCnBoxQr(raw)` → `{ invoiceNo, boxSeq, totalBoxes } | null` —
     trim, split `;`, require ≥ 6 fields; field 1 integer; field 2
     `/^[A-Z0-9][A-Z0-9-]*$/i`; fields 3–5 positive integers;
     `boxSeq <= totalBoxes`.
   - `resolveCnBox(qr, items)` → `{ ctnNo, lines } | { error }` — filter
     items by `invoiceNo`, distinct numeric `ctnNo` sorted numerically,
     1-based index; errors: `wrong_order` (no items for the invoice),
     `no_numeric_ctn`, `not_found` (seq out of range). Lines include
     done lines (targeting must be stable after partial put-away).
4. **Tests** `apps/pda/tests/cnBoxQr.test.ts` (new, vitest)
   - Both real payloads parse; rejections: shelf code, `BOX-1`, KOA label,
     5-field payload, `boxSeq > totalBoxes`, non-numeric seq.
   - Resolver: GZ-26110068 → 1/4 = ctn 38 (4 lines), SZ-26110077 → 1/2 =
     ctn 25 (6 lines); multi-invoice orders scope boxes per invoice;
     out-of-range seq; non-numeric ctn filtered; done lines still resolve.
5. **Dialog** `apps/pda/components/put-away/CnBoxDialog.vue` (new)
   - Props: box header (`invoiceNo`, `ctnNo`, `boxSeq`, `totalBoxes`),
     `lines` (box items + staged qty per line), `selectedItemId`.
   - Emits: `close`; selection is driven by the parent (scans), taps emit
     `select(itemId)`; per-row remaining = `remainingQty − staged`; done
     lines struck through; suggested shelf chip per row.
6. **Page** `apps/pda/pages/put-away/[id].vue`
   - `utils/cnBoxQr` import; `boxDialog` ref (null | resolved box +
     `selected: { portions, batch } | null`).
   - `onScan` routing, CN mode only, after the shelf-code check:
     a. dialog closed + `parseCnBoxQr` hit → resolve against
        `order.items` → open dialog or toast the specific error.
     b. dialog open + shelf scan → staged: `addCnPieces(portions,
        batch, shelfCode, boxId = ctnNo)`; clear selection; keep open.
     c. dialog open + no selection + shelf scan →
        `putAway.cn.box.selectFirst` toast, swallow.
     d. dialog open + item label → `parseRawValue` + COO/COW guard +
        `findCnPutAwayTargets` over the box's lines → set selection.
     e. dialog open + another box QR → re-resolve, switch box.
   - `addCnPieces` gains `shelfCode`/`boxId` params (callers updated;
     existing behavior defaults unchanged).
   - Standard (non-CN) mode: a box QR hits the existing
     `putAway.boxScanIgnored` toast.
7. **i18n** `layers/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — `putAway.cn.box.*`
   (title, empty/done rows, selectFirst, wrongOrder, notFound) + reuse
   `errors.scanned_part_does_not_match_item`.
8. **Docs** — `docs/app-docs/flows/put-away/` (steps/ai-scope: carton-QR
   dialog path) + UAT `docs/uat/features/CR-064.json`; regenerate
   `UAT-Test-Tracking.xlsx` (`node scripts/gen-uat-xlsx.mjs`).
9. **Verify** — `pnpm --filter @warehouse/pda test` + `build`;
   `pnpm --filter @warehouse/backend test` + `build`; `nuxt prepare`.
10. **Commit.**

## Notes

- No new backend endpoints; the one aggregate already carries `ctnNo`, and
  the complete call already persists `boxId` onto the lot.
- The camera path on this page is the per-group review modal, not a box
  entry point — carton QRs enter via the hardware/wedge `onScan` pipeline,
  the single routing point for this feature.
- Chrome 101: parser is string math only; no new Web APIs.
