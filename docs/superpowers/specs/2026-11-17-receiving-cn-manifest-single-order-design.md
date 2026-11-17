# CN receiving — HK truck manifest becomes ONE order with multiple invoices, auto-arrived, straight to put-away

Date: 2026-11-17 · App: admin + backend · Function: ADM-023
Spec: `2026-11-17-receiving-cn-manifest-single-order-design.md`
Builds on: `2026-11-08-receiving-cn-excel-local-upload-design.md`,
`2026-11-10-receiving-cn-truck-manifest-upload-design.md`

## Problem

The truck-manifest upload (車單, spec 2026-11-10) splits one file into N
pending orders — one per `INVOICE NO` — and each order then waits for the
admin confirm → PDA 收貨掃描 → finalize chain before its put-away task
exists. Operators asked for two behavioral changes, **only for the manifest
(HK) format**; the TE 收貨確認 format keeps today's flow untouched:

1. **One order per manifest file, carrying all its invoices.** A truck
   arrives as one physical event; the PDA put-away and the admin list should
   mirror that (one task, `invoiceNos` list) instead of N disconnected
   single-invoice orders.
2. **The sheet is the verification.** The manifest is the supplier's own
   shipping document, so the created order must arrive confirmed
   (`in_hand` + arrival stamps, `received_qty = line_qty`) with its
   `put_away_tasks_cn` task created **in the same transaction** — no admin
   confirm, no PDA receiving scan. Stock is put away straight from the sheet.

## Why this is possible without schema changes

- `receiving_invoices_cn.receiving_order_id` is a plain FK — nothing enforces
  one invoice per order. All read paths already iterate invoices:
  `getCnOrderDetail` returns `invoices: [...]`, the PDA CN put-away list
  selects `invoiceNos` (`putawayCn.ts`), the scan task queries join through
  invoices (manifest orders never enter `scanning`, so scan pages simply
  never see them).
- `createCnManualReceipt` (PDA manual receiving) already implements the
  create→`in_hand`→put-away-task-in-one-tx pattern this spec copies.
- `put_away_tasks_cn` has a unique index per order, not per invoice.

## Decisions

- **Format-based split, not a user toggle.** `new.vue` already detects the
  format per sheet (confirmation parse first, manifest fallback). Detection
  outcome now also picks the post-create behavior: confirmation (TE) → a
  pending order riding the scan chain; manifest (HK) → the single-order,
  arrived-with-put-away flow. No new flow-config knob.
- **Verify/edit step for both formats (revised decision).** The first
  cut shipped manifests as auto-create-only — any gate issue rejected the
  whole file with no chance to fix sheet quirks in-app. Operators found the
  reject-and-fix loop too painful (2026-11-17 go-live feedback), so the
  step-2 editor now opens for manifests exactly like TE sheets: ambiguous
  part keys stay a non-blocking warning, invalid-qty rows are highlighted
  and dropped from the payload on submit, and everything else opens the
  editor with the error banner. Manifest-specific editor differences: the
  brand input and the single 編號 input are hidden (meaningless for a
  truck), an editable INVOICE NO column shows the per-row invoice group
  (a mis-grouped row can be re-assigned), and the totals cross-check banner
  is skipped (its fallback target is the parse-time sum, which any
  intentional edit departs from — it could never clear).
- **Order number = truck ref + date (user choice):**
  `batch_no = [REF]-YYYYMMDD` (e.g. `CSZ00-20261102`), sanitized to
  `[A-Z0-9-]`; on collision the same day, append `-2`, `-3`, … Blank/absent
  `Ref :` falls back to `CN-YYYYMMDD`. Each `receiving_invoices_cn` row keeps
  its real `INVOICE NO` (invoice_no), `total_qty` = Σ group qty, and
  `total_ctn` = the merge-aware distinct-carton count the client already
  computes.
- **No brand requirement.** Multi-brand manifests make the single-brand
  `[brand]-YYYYMMDD-seq` numbering meaningless; the brand input/derivation is
  skipped for manifest drafts. The parts gate still validates every distinct
  型號 against the parts master (unknown MPNs block the upload).
- **received = as-declared.** Every item is inserted with
  `received_qty = line_qty` (the put-away quantity cap), `scan_status` stays
  NULL — the scan columns only exist for the PDF/TE scan chain.
- **No allocation trigger**, matching the manual-receipt rule: allocation
  recompute stays manual-only (admin Re-allocate / confirm-arrival).
- **One workflow tracking row per manifest file** (`phase: 'excel'`,
  `status: 'completed'`, `batch_no` = the new order number, payload = the
  full verified payload) — the admin list joins order ↔ tracking by
  `batch_no` as today. The status cron ignores `completed` rows.
- **Assignee NULL** on the created put-away task (visible to every PDA user),
  same as the manual-receipt task; assignable later via task assignments.

## Endpoint contract change

`POST /admin/receiving-cn/excel` gains a per-file discriminator; the contract
stays all-or-nothing across all files in one submit:

```jsonc
// TE / confirmation — unchanged from 2026-11-08
{ "filename": "TE20261010-2.xls", "brand": "TE (optional)",
  "payload": { "invoiceNo": "TE20261010-2", /* … */ "items": [ /* … */ ] } }

// HK / truck manifest — new
{ "filename": "CSZ00-manifest.xls", "mode": "manifest",
  "payload": {
    "receiptNo": "CSZ00",            // truck Ref : (order-number prefix)
    "receivedDate": "2026-11-02",    // sheet Date : (fallback: creation day)
    "receivedOffice": "… (optional)",
    "invoices": [
      { "invoiceNo": "TE20261010-2", "totalQty": 12345, "totalCtn": 6,
        "items": [ { "poNo": "…", "partNo": "…", "ctnNo": "…",
                     "dateCode": "…", "qty": 300000, "office": "…",
                     "remark": "…", "cartonNo": "1", "cartonMerged": true } ] }
    ] } }
```

- `mode` omitted = confirmation (backwards compatible).
- `validateCnManifestPayload`: `invoices` non-empty; each invoice
  `invoiceNo` non-empty, `items` non-empty; item rules identical to
  `validateCnPayload` (`poNo` required, `qty` positive integer, `partNo`
  non-empty). `totalCtn` optional integer. Errors use the existing
  `invalid_payload: …` 400 shape.

## What the transaction writes per manifest file

One tx (mirrors `createCnManualReceipt` + the excel path's helpers
`resolvePartByKey`, `deriveCnManualOrgSub`, `cnOrderPair`):

1. `receiving_orders_cn`: `status = 'in_hand'`, `arrived_at`/`arrived_by` =
   now/actor, `batch_no = [REF]-YYYYMMDD(-seq)`, `delivery_date` = sheet
   `receivedDate` (UTC-midnight literal) else creation day, `org_id` = first
   item's `deriveCnManualOrgSub(poNo).orgId`.
2. N × `receiving_invoices_cn`: `invoice_no` = the group INVOICE NO,
   `total_qty` = Σ group qty, `total_ctn` = client-counted distinct cartons,
   `org_id` per first item of the group.
3. Items (`receiving_invoice_items_cn`): grouped per invoice by `poNo` —
   same shape as the excel path, plus `received_qty = line_qty` and
   `additional_data = { source: "excel-manifest", filename, invoiceNo }`;
   canonical `part_no`/`wcl_item_no` backfilled on a unique parts-master
   match; `org_id`/`sub_inventory_code` from `deriveCnManualOrgSub(poNo)`.
4. `put_away_tasks_cn` (only when ≥1 item): uniform item pair wins, else
   order org + NULL sub-inventory — `cnOrderPair` rule, identical to the
   scan finalize / manual receipt.
5. `receiving_cn_workflows` tracking row (`phase: 'excel'`,
   `status: 'completed'`, `batch_no` = order number, full payload).
6. `transaction_logs`: order `null → in_hand` (+ `source:
   "excel-manifest"`), put-away task `null → pending`, workflow
   `null → completed`; one SSE `receiving_cn.completed` on
   `/admin/receiving-cn` + `/put-away-tasks`.

## Admin UI (`apps/admin`)

- `utils/cnReceivingExcel.ts`
  - `CnReceivingItem` gains optional `invoiceNo` (set per row by
    `parseCnManifestAoa`; unused by the confirmation parser).
  - `CnReceivingDraft` gains `mode: "confirmation" | "manifest"`;
    manifest drafts keep one shared header (truck `Date :`/`Ref :`) and flat
    items carrying per-row `invoiceNo`. Per-group totals are derived for the
    gate banner (group items by `invoiceNo`).
  - `checkCnDraft`: skip the `noInvoiceNo` header check for manifest drafts
    (invoice numbers live on rows/groups); row checks unchanged.
  - `cnDraftToEntry`: manifest drafts map to the new wire shape (no `brand`).
- `pages/receiving-cn/new.vue`
  - `addExcelDraft`: confirmation parse hit → one draft per file (unchanged);
    manifest fallback → **one** draft for the whole file (no `(INVOICE NO)`
    filename tagging).
  - `gateAndAutoCreate`: one grading rule for both formats — ambiguous part
    keys are non-blocking warnings, invalid-qty rows open the editor with
    the warning banner, everything else opens the editor with the error
    banner. Brand prefill stays confirmation-only.
- `components/receiving-cn/CnExcelDraftEditor.vue` — manifest drafts: brand
  and single-編號 inputs hidden, editable INVOICE NO column (per-row group,
  re-assignable), totals cross-check banner skipped (self-referential once
  edited).

## Ceilings (`shortcut:` comments in code)

- Mixed-format submits still work (per-file `mode`), all-or-nothing.
- Manifest rows the parts gate flags as unknown MPNs block auto-create and
  open the editor — the admin fixes the partNo there (combobox-validated)
  or removes the row; there is no parts-master editing in-app.
- Physical cartons spanning two invoices still count once per invoice (2026-
  11-10 shortcut) — now visible as `total_ctn` per invoice row.
- Admin "Reset order" on a manifest order returns it to `pending` with
  received qty zeroed and the put-away task deleted — from there it can ride
  the normal confirm → scan chain if ever needed.
- `date_code` at order level stays NULL; per-item date codes only.

## Verification

- `apps/admin/tests/cnReceivingExcel.test.ts` — manifest decode now yields
  one draft's items tagged per invoice; draft→wire mapping emits
  `mode: "manifest"` + `invoices[]`; TE fixtures unchanged.
- `apps/backend/src/routes/admin/receivingCn.test.ts` — manifest upload: 1
  order (in_hand, arrived stamps, `CSZ00-20261102` batch_no), N invoices with
  real INVOICE NOs, `received_qty = line_qty`, put-away task created with the
  `cnOrderPair` pair, tracking row + logs + SSE; collision suffix `-2`;
  rollback when a later file in the same submit fails; TE entry regression
  (still pending + no put-away task).
- Manual: upload the CSZ00 fixture → one `CSZ00-20261102` order with 34
  invoices, appears immediately in the PDA CN put-away list; corrupt one
  row's qty (or blank its PO) → the verify/edit step opens for the manifest
  with the issue banner, the INVOICE NO column shows each row's group, fixes
  submit; upload a TE sheet → unchanged pending order + scan chain.

## Docs

- Update `docs/app-docs/flows/<cn-receiving>/` (overview/steps/ai-scope) and
  `docs/app-docs/ai/feature-registry.md` for the split behavior.
- Follow-up notes on specs 2026-11-08 / 2026-11-10 pointing here.
