# Customer Receiving Order Upload (CN Receiving) — Design Spec

**Date:** 2026-10-16
**Status:** Approved
**Phases:** Phase 1 (Excel upload) in this spec; Phase 2 (PDF + OCR) shares the architecture and is flagged where it differs.

## Summary

New admin feature "customer receiving order upload" for CN warehouses: an admin uploads a customer receiving Excel (收貨確認及付款通知書), the app decodes it client-side, the user verifies/edits the parsed rows, and on submit the backend forwards the original file + the verified JSON to DocPal — first uploading the file (getting a document id), then kick-starting a DocPal workflow with that document id and the JSON as variables. The workflow eventually syncs data back into new `_cn` tables (via the external upstream-sync service); a backend cron tracks workflow status per upload and, on completion, finalizes the CN order and creates a **dedicated CN put-away task** that the PDA put-away flow executes. Warehouses using this flow do not use the standard receiving flow — the two worlds stay fully separate.

## Background / confirmed integration facts

- Example source file: `supporting_doc/cn_receiving/TE20261010-2.xls` — fixed form: title row, label/value header rows (收貨辦事處 / 供應商 / 發票號碼 / 編號 / 收貨日期 — the date is an Excel serial number), an item table (訂單號 | 箱数 | 型號 | 摘要(D/C) | 數量(PCS) | 重量（KG) | 辦事處 | 发货项 | 備註) terminated by a 合计 row, then footer/notice rows.
- DocPal endpoints (UAT `https://uat.docpal.weltronics.com`):
  - `POST /api/docpal/workflow/upload/file` — multipart: `document` (JSON string `{"properties":{"dc:title":...},"type":"File"}`), `nonPermission: "true"`, `file` → returns `{code, data}` where `data.id` is the document id.
  - `DELETE /api/docpal/workflow/task/attachment?attachmentId=<id>` — delete an uploaded attachment (cleanup on kick-start failure).
  - `POST /oniflow/api/v1/processes` — body `{start_user_id, definition_id, variables}` → returns `{code:201, data}` with `data.id` (process id), `data.business_key`, `data.state.type`.
- **DocPal developer confirmed the workflow API does not verify the bearer token nor `start_user_id`.** We therefore use one configured service token (`DOCPAL_WORKFLOW_TOKEN`, from a dedicated low-privilege DocPal account) for all workflow/file calls, and send the *real logged-in admin* as `start_user_id` / `__system__user_creator_*` variables so the workflow instance carries the correct creator identity. No per-user DocPal token storage; the `users` table and auth flow are untouched.

## Data model

New file `apps/backend/src/db/schema/receivingCn.ts` (Drizzle; `newId()`, `now()` helpers, cascade FK chains, `db:generate` migration):

- `receiving_orders_cn` — per the provided DDL: `id` (text PK), `batch_no`, `delivery_date`, `org_id` (int, default 2), `date_code`, `status` (default `'pending'`), `arrived_at`, `arrived_by`, timestamps.
- `receiving_invoices_cn` — `id`, `receiving_order_id` (FK cascade), `invoice_no`, `total_qty`, `total_ctn`, `delivery_date`, `org_id`, timestamps.
- `receiving_invoice_items_cn` — `id`, `receiving_invoice_id` (FK cascade), `part_no`, `wcl_item_no`, `po_no`, `po_line`, `line_qty`, `received_qty` (0), `picked_qty` (0), `put_away_qty` (0), `ctn_no`, `date_code`, `lot_code`, `coo`, `cow`, `org_id`, `sub_inventory_code`, mismatch fields, `additional_data`/`order_data` jsonb, timestamps, `drawing_no`.
- `put_away_tasks_cn` — dedicated CN put-away task (does NOT touch `put_away_tasks`): `id`, `receiving_order_cn_id` (text, NOT NULL, UNIQUE, FK → `receiving_orders_cn.id` cascade), `org_id`, `sub_inventory_code` (uniform-pair derivation from the order's items, NULL when mixed), `status` (`pending | completed`, default `pending`), timestamps.
- `receiving_cn_workflows` — upload tracking: `id`, `phase` (`excel | pdf`), `invoice_no` (CN 編號 = `batch_no`), `supplier`, `filename`, `docpal_document_id`, `docpal_process_id`, `docpal_business_key`, `status` (`workflow_running | completed | failed | cancelled`, default `workflow_running`), `payload` jsonb (the verified `excel_result_data`), `error`, `created_by`, timestamps.

**Assumption (open integration point):** the external upstream-sync service writes `receiving_orders_cn` / `receiving_invoices_cn` / `receiving_invoice_items_cn` from the DocPal workflow output, the same way it writes masters/orders today. Our backend treats them as read-only input for finalization/put-away, matched by `batch_no` = the CN 編號 from the verified payload.

## Backend

### Config (`src/config.ts`, call-time env getters)

`docpalWorkflowToken()` (unset → requests fail 500 `docpal_workflow_token_not_configured`), `docpalCnExcelWorkflowId()`, `docpalCnPdfWorkflowId()` (phase 2), `receivingCnSyncDisabled()`, `receivingCnSyncIntervalSec()` (default 120).

### DocPal workflow client (`src/docpalWorkflow.ts`)

Mirrors `src/print.ts` error handling (timeout via `AbortSignal`, upstream failure → `HTTPException(502, "docpal_workflow: ...")`). All calls send `Authorization: Bearer <DOCPAL_WORKFLOW_TOKEN>`:

- `uploadWorkflowFile(filename, mime, bytes, title)` → `POST /api/docpal/workflow/upload/file` (multipart `FormData`: `document`, `nonPermission`, `file`) → returns `data` (document id = `data.id`).
- `deleteWorkflowAttachment(documentId)` → `DELETE /api/docpal/workflow/task/attachment?attachmentId=...`.
- `startProcess(definitionId, variables)` → `POST /oniflow/api/v1/processes` → returns `data` (process id, business key).
- `getProcess(processId)` → `GET /oniflow/api/v1/processes/:id` (exact status route to confirm; used by the cron).
- `getOcrResult(documentId)` — phase 2 placeholder (DocPal OCR-result endpoint TBC).

### Upload flow (`src/db/receivingCn.ts` — `createCnUpload`)

1. `uploadWorkflowFile` → document id.
2. Build `variables`: `excelFiles: [entry shaped from the upload response]` + `excel_result_data: <verified payload>`; `start_user_id` / `__system__user_creator_id` / `__system__user_creator_name` = the actual admin user (from the JWT actor + users row).
3. `startProcess(docpalCnExcelWorkflowId(), variables)` → process id + business key.
4. One tx: insert `receiving_cn_workflows` + `transaction_logs` (`entityType: "receiving_cn_workflow"`, uploaded→workflow_running).
5. If step 3 fails after step 1 succeeded: `deleteWorkflowAttachment`, then 502.

### Status cron (`src/jobs/receivingCnSync.ts`, wired in `src/server.ts`)

Self-rescheduling `setTimeout` loop (pattern: `jobs/goodsVerifyDayEnd.ts`; `unref()`; env kill-switch; log-only failures). Each tick: load `receiving_cn_workflows` rows in `workflow_running`, `getProcess` each; terminal state → update status; `completed` → `finalizeCnOrder` (below); `failed/cancelled` → record `error`.

### Finalize (`src/db/receivingCn.ts` — `finalizeCnOrder`, idempotent via the unique index on `put_away_tasks_cn.receiving_order_cn_id`)

1. Read `receiving_orders_cn` (+ invoices/items) by `batch_no = workflow.invoice_no`; if the upstream sync hasn't written them yet, log and retry on the next poll.
2. Tx: order `status → 'in_hand'`, stamp `arrived_at`; insert `put_away_tasks_cn` (org/sub-inventory uniform-pair derivation); `transaction_logs` rows; workflow `status = 'completed'`; SSE `emitEvent` `receiving_cn.completed` on topic `/admin/receiving-cn`.
3. No allocation schedule here — allocation only sees stock once put-away completes and writes on-hand lots.

### Admin routes (`src/routes/admin/receivingCn.ts`, mounted in `src/routes/admin/index.ts`, admin JWT only)

- `GET /admin/receiving-cn` — list, status filter + server paging.
- `GET /admin/receiving-cn/:id` — detail incl. payload items.
- `POST /admin/receiving-cn/excel` — multipart (`file` + `data` JSON string) → validate payload → `createCnUpload(phase: "excel")`.
- `POST /admin/receiving-cn/pdf/ocr` / `POST /admin/receiving-cn/pdf` — **phase 2** (blocked on the DocPal OCR-result endpoint).

Payload validation: header fields are strings; `items` non-empty; each item needs `partNo`/`orderNo` non-empty, `qty` positive-integer-like. 400 `invalid_payload` otherwise.

### PDA CN put-away variant (`cnReceiving` flow-config flag)

New top-level boolean `cnReceiving` (default false) on the `warehouse_config` "flow" row. When true, the PDA put-away list/detail read CN tasks instead of standard tasks (a warehouse runs one flow or the other).

- `src/db/putawayCn.ts`: `listCnPutAwayTasks`, `getCnPutAwayTaskDetail` (from `put_away_tasks_cn` + `receiving_invoice_items_cn`, grouping mirroring the standard candidates query), `completeCnPutAwayTx` (per-item `put_away_qty` updates + `inventory_transactions` PUT_AWAY rows `qty_type: 'on_hand'` creating stock lots + task completion check + `transaction_logs` + SSE on `/put-away-tasks`).
- Separate route paths for isolation: `GET /put-away-cn/tasks`, `GET /put-away-cn/tasks/:id`, `POST /put-away-cn/tasks/:id/complete`.
- After completion commit: `scheduleAllocateAll`.

### Accepted v1 differences

- CN stock does not appear in allocation dock availability before put-away completes (no RECEIVE_TO_DOCK ledger in the CN path).
- Standard receiving admin pages are untouched; CN put-away logic can diverge freely from the standard flow.

## Frontend (admin)

- `utils/cnReceivingExcel.ts` (+ vitest): AOA → `{receivedOffice, supplier, receiptNo, invoiceNo, receivedDate, items[]}`. Find the item header row by col-0 `訂單號`; map 9 columns by header text; stop at col-0 `合计` / `收貨注意事項`; label-scan the header fields; convert Excel serial dates (`XLSX.SSF.parse_date_code`); coerce `qty`/`cartonNo`/`dateCode` to strings; keep `poNo` as string (large numbers).
- `pages/receiving-cn/index.vue` — tracking list (`useAdminTable` + `useUrlQueryState`, SSE reload on `/admin/receiving-cn`), "New upload" button.
- `pages/receiving-cn/new.vue` — wizard: file pick → verify/edit (header form + `<DataTable>` + row edit modal mirroring `components/receiving/ItemEditModal.vue`, add/remove row, Σ carton/qty cross-check vs 合计 with mismatch banner) → submit `FormData` (`file` + `data`) to `/admin/receiving-cn/excel`; 502 → error banner.
- `utils/flowApi.ts` typed wrappers; nav entry in `utils/entities.ts`; i18n keys in `layers/i18n` all three locales; `apps/admin/TOC.md`.

## Phase 2 (PDF + OCR)

Same architecture; differences only: file type pdf, `POST /admin/receiving-cn/pdf/ocr` returns OCR-extracted draft items for the same verify UI, and the PDF workflow definition's variable shape. Blocked on: DocPal OCR-result endpoint confirmation, PDF workflow variable shape, `DOCPAL_CN_PDF_WORKFLOW_ID`.

## Open items

1. Upstream-sync writes the `_cn` tables (assumed external service from workflow output).
2. DocPal OCR-result endpoint + PDF workflow variables (phase 2).
3. Workflow definition ids per environment (`DOCPAL_CN_EXCEL_WORKFLOW_ID`, later `DOCPAL_CN_PDF_WORKFLOW_ID`); the service-token account needs file-upload + workflow-start permissions.
4. CN status naming — finalize sets `in_hand`; confirm what statuses the sync writes (`pending` default in DDL).
