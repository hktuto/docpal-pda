# CN receiving upload — truck-manifest Excel format (CSZ00 車單)

Date: 2026-11-10 · App: admin · Function: ADM-023
Spec: `2026-11-10-receiving-cn-truck-manifest-upload-design.md`

## Problem

The CN receiving Excel upload (spec
`2026-11-08-receiving-cn-excel-local-upload-design.md`) decodes only the
single-invoice 收貨確認及付款通知書 form. Customers also ship per-truck
manifests — e.g. `02-NOV-2026 (30 Oct)---CSZ00---第1車 PRC 1.xls` — which are
**multi-brand and multi-invoice** (the reference file carries 34 invoices /
257 item rows in 181 cartons). The old decoder returns 0 items on them
(no `訂單號` header, no `編號:` label), so the upload simply failed.

The layout is the same truck manifest the 2026-07-27 seed spec decoded
server-side from `210726.xls` for `seed-order-210726.ts`:

| `Date :` / `Ref :` label rows | then one item table |
| --- | --- |
| serial date + truck reference | `C/No. \| Size \| G.W \| INVOICE NO \| OFFICE NAME \| PO NO \| Our P/No. \| Quantity \| 產品 \| Description \| 產地 \| (unlabeled remark)` |

Quirks: continuation rows repeat nothing but leave `C/No.`/`G.W` blank (they
belong to the carton above); rows without `INVOICE NO` are not items — the
`34-36 NIL` reserved-carton row and the trailing `9紙板/1合成板/6膠板` packing
summaries; there is no 合计 row.

## Design

Client-side only — the backend contract (`POST /admin/receiving-cn/excel`,
N file entries = N pending orders, all-or-nothing) is unchanged.

1. **`parseCnManifestAoa(aoa): CnReceivingParseResult[]`**
   (`apps/admin/utils/cnReceivingExcel.ts`): detects the item table by its
   `C/No.` col-0 header + an `INVOICE NO` column, then decodes **one payload
   per INVOICE NO**, in first-appearance order. This is what the user asked
   for: "detect and parse differently" per format, multi-brand included —
   each invoice group is single-brand (same invariant the 210726 seed used),
   so the per-draft brand derivation (parts master, then admin override)
   keeps working.
2. **Column mapping** reuses `CnReceivingItem`, so the verify/edit draft
   editor, the upload gate and the wire swap (`cnDraftToEntry`) need no
   changes: `PO NO` → `orderNo` (ships as wire `poNo`), `Our P/No.` →
   `partNo` (verbatim brand-prefixed WCL key, e.g. `KOA/RK73G1HTTCM 1002D`),
   `Quantity` → `qty`, `G.W` → `weight`, `OFFICE NAME` → `office` and the
   group's `receivedOffice`, `Date :` serial → `receivedDate`, `Ref :` →
   `receiptNo`, the unlabeled trailing column → `remark`. Size/產品/
   Description/產地 have no home on the upload wire → dropped, same call as
   the seed spec (origin/COO stays editable per item on the order detail).
3. **Carton handling**: a blank `C/No.` inherits the last non-blank one
   (carried down). Each distinct carton stamps `cartonNo="1"` on its group
   rows; continuation rows get `cartonMerged` so the cross-check Σ counts a
   carton once. A physical carton spanning two invoices counts once **per
   invoice** (documented shortcut).
4. **Detection order** in `pages/receiving-cn/new.vue`: per sheet, try the
   confirmation parse first; if it finds no item rows, try the manifest
   decoder. Neither → the existing `noItems` error. A manifest upload fans
   out into N drafts (filenames tagged `(INVOICE NO)`) and submits them as
   N entries in one all-or-nothing request.

## Verification

- `apps/admin/tests/cnReceivingExcel.test.ts` — the real file is the fixture
  (`supporting_doc/cn_receiving/CSZ00-manifest-20261102.xls`): 34 groups /
  257 items / Σqty 5,078,080 / Σcarton 182, carry-down + merge marks, the
  unlabeled remark column, packing/NIL rows skipped, gate clean, and both
  parsers cold on the other's format.
- Manual: upload the file on `/receiving-cn/new`, confirm the drafts split
  per invoice and the parts gate flags only genuinely unknown MPNs.

## Follow-ups (not in scope)

- Supplier/發票 receipt fields are blank on manifests (no equivalent column)
  — admin edits them in the draft if needed.
- `validateCnPayload` rejects `qty: 0`, so reserved `NIL` cartons can only be
  represented by an admin-edited row today.
