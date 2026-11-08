# CN receiving — local Excel upload (direct pending-order creation)

Date: 2026-11-08 · Status: approved · Supersedes the DocPal excel-workflow phase 1 of `2026-10-16-customer-receiving-upload-design.md`

## Problem

The CN receiving upload (admin `POST /receiving-cn/pdf`) sends scanned 收貨確認 PDFs to a DocPal workflow for OCR; the external upstream sync later writes the `receiving_orders_cn` world as `pending`, and the admin confirm / PDA 收貨掃描 steps follow. Phase 1 (Excel upload → verified rows → DocPal excel workflow) was retired with the PDA manual-receiving rewrite (`f9eab952`).

Operators now want the Excel upload back. The sheet data is the supplier's own 收货确认 — effectively already verified — so instead of starting a DocPal workflow, the upload decodes the Excel **locally** (in the admin browser, with the still-present decoder `utils/cnReceivingExcel.ts`) and creates the CN receiving order directly in our DB.

## Decisions

- **Trust but review**: the upload keeps a step-2 verify/edit screen (the retired wizard's inline table + `ReceivingCnPartNoSelect` + totals cross-check), because real sheets carry quirks (型號 embedding the date code, blank 摘要). No auto-create-without-review.
- **Order state = `pending`** (user choice): the order lands exactly like a sync-created pdf order — one invoice, items with `line_qty` = sheet qty, `received_qty` = 0, no put-away task. The existing admin confirm → `scanning` → PDA 收貨掃描 → finalize chain runs unchanged. The Excel qty is the expected quantity the scan verifies.
- **Multiple Excel files per upload**: one submit decodes N files and creates **N orders** (each file is its own 收货确认 with its own 編號/供應商/日期) in ONE transaction — all-or-nothing. PDF and Excel can't be mixed in one submit (rejected with the file-type error).
- **No DocPal involvement**: file bytes are not uploaded anywhere (the order detail already re-exports the sheet as .xlsx via `cnReceivingExcelExport`; the full verified payload is preserved on the tracking row).
- **Numbering**: shared branded namespace — `batch_no = invoice_no = [brand]-YYYYMMDD-seq` via `nextCnBrandedNo` (same as pdf/manual). The sheet's 編號 (e.g. `SH-KOA261029K2-2`) is stored on the tracking row's `invoice_no`, which the admin CN list joins back by `batch_no` — traceability without a schema change.
- **Brand is admin input, not derived**: each file's verify section has a required 品牌 input (drives the `[brand]-…` numbering; `KOA`, `TE`, …). Prefill is deliberately not derived from supplier profiles or 編號 parsing.

## Endpoint contract

`POST /admin/receiving-cn/excel` (replaces the old multipart shape; gated by the `receiving-cn` flow step like the rest of the surface):

```json
{ "files": [
  { "filename": "收货确认SH-KOA261029K2-2.xls",
    "brand": "KOA",
    "payload": { "receivedOffice": "...", "supplier": "...", "receiptNo": "...",
                 "invoiceNo": "SH-KOA261029K2-2", "receivedDate": "2026-10-29",
                 "items": [ { "index": 1, "orderNo": "发货项", "poNo": "訂單號",
                              "partNo": "...", "ctnNo": "...", "dateCode": "...", "qty": 300000,
                              "cartonNo": "...", "weight": "...", "office": "...", "remark": "..." } ] } }
] }
```

- `payload` is validated by the existing `validateCnPayload` (wire contract: `poNo` carries 訂單號 — required; `orderNo` the 发货項 — may be blank; qty positive integer).
- `brand` must match `^[A-Z][A-Z0-9]{1,9}$` (uppercased before validation). `filename` optional (defaults `upload.xls`).
- Errors: 400 `invalid_payload: files must be a non-empty array` / per-item shape errors / `invalid_payload: brand must match ...`.
- 201 `{ "orders": [{ "id", "batchNo" }, ...] }`.

## What the transaction writes, per file

Mirrors the `createCnManualReceipt` insert block with pending-path values (shares its helpers `nextCnBrandedNo`, `deriveCnManualOrgSub`, `resolvePartByKey`):

1. `receiving_orders_cn`: `status='pending'`, `batch_no = [brand]-YYYYMMDD-seq`, `delivery_date` = sheet `receivedDate` (UTC-midnight literal) else creation day, `org_id` = first 訂單號 prefix derivation, arrival stamps NULL (detail-open `prepareCnOrderDetail` stamps them as today).
2. One `receiving_invoices_cn` (`invoice_no = batch_no`, `total_qty` = Σ qty; `total_ctn` NULL — see ceilings).
3. `receiving_invoice_items_cn`: grouped by `poNo` (訂單號), `po_no = 訂單號`, `line_qty = qty`, `received_qty` 0 (default), `po_line = sheet row index`, `date_code` from 摘要, `ctn_no` = 箱號 carton number, org/sub per `deriveCnManualOrgSub(訂單號)`, canonical `part_no`/`wcl_item_no` backfilled on a unique parts-master match, `additional_data = { "source": "excel", "filename", "invoiceNo": 編號 }`.
4. `receiving_cn_workflows` tracking row: `phase='excel'`, `status='completed'`, `batch_no` = generated number, `invoice_no` = sheet 編號, `supplier`, `filename`, `payload` = validated payload, docpal document/process/business-key NULL. The status cron selects only `workflow_running AND docpal_process_id IS NOT NULL`, so it ignores these rows.
5. `transaction_logs`: order `null → pending` (+ workflow `null → completed` referencing the order, like `finalizeCnOrder` does) and one `receiving_cn.updated` SSE on `/admin/receiving-cn`.

## UI (admin `pages/receiving-cn/new.vue`)

One dropzone, `accept=".pdf,.xls,.xlsx"` `multiple`. Classification on pick: PDFs → current one-shot `submitCnPdfUpload` (no step 2, unchanged). Excel(s) → decode each with `XLSX.read` + `fillMergedCells` + `parseCnReceivingAoa` (content-based sheet pick: first sheet whose item table decodes; for the sample workbook that's `Sheet1`, the 635-row master confirmation) → step 2 stacks one editable review section per file → 確認 posts all files. A file that decodes 0 items is an error banner; remove it to proceed. Mixing PDFs and Excels in one submit is rejected.

## Ceilings (`shortcut:` comments in code)

- `total_ctn` not filled — the merge-aware carton sum exists only client-side before submit; revisit if a consumer needs it.
- 发货項/箱数/重量/辦事處/備註 live only in the tracking-row payload, not on item columns (箱號 is a column: `ctn_no`).
- No duplicate-編號 guard: the sheet 編號 is free text on the tracking row; `batch_no` uniqueness comes from the branded sequence.
- `delivery_date` = sheet date else today; the sheet date is not sanity-checked against upstream order dates.
- The old excel-phase branch of `createCnUpload` is left in place but unused by any route.
