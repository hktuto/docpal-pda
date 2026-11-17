# Plan — CN receiving: HK manifest = one multi-invoice order, auto-arrived, straight to put-away

Spec: `docs/superpowers/specs/2026-11-17-receiving-cn-manifest-single-order-design.md`
Date: 2026-11-17

## Step 1 — Backend: manifest payload + creation

**`apps/backend/src/db/receivingCn.ts`**

1. Add `CnManifestPayload` type + `validateCnManifestPayload(raw)` next to
   `validateCnPayload` (line ~77): `receiptNo`/`receivedDate`/`receivedOffice`
   optional strings; `invoices` non-empty array of `{ invoiceNo: non-empty,
   totalQty?, totalCtn?, items: non-empty }` where items reuse the existing
   per-item rules (`poNo` required, `qty` positive int, `partNo` non-empty).
   Same `invalid_payload: …` 400 style.
2. Add `nextCnTruckNo(tx, ref, at)`: sanitize ref (uppercase, strip to
   `[A-Z0-9-]`, blank → `CN`), candidate `[REF]-YYYYMMDD`, then `-2`, `-3`, …
   until `receiving_orders_cn.batch_no` is free (indexed lookup loop).
3. Add `insertCnManifestOrderTx(tx, file, actor)` modeled on
   `insertCnExcelOrderTx` + `createCnManualReceipt`:
   - brand NOT required; skip brand derivation entirely.
   - one `receiving_orders_cn` (`status: "in_hand"`, arrived stamps, batch_no
     via `nextCnTruckNo(receiptNo)`, delivery_date = sheet date else today).
   - per invoice group: one `receiving_invoices_cn` (`invoice_no` = group
     INVOICE NO, `totalQty`, `totalCtn`, org per first item) + its items
     (`receivedQty = lineQty`, org/sub via `deriveCnManualOrgSub(poNo)`,
     canonical part keys via `resolvePartByKey`,
     `additional_data: { source: "excel-manifest", filename, invoiceNo }`).
   - `put_away_tasks_cn` insert when ≥1 item, pair via `cnOrderPair`
     (fallback order org + NULL sub), plain insert (new order — no conflict).
   - logs: order `null → in_hand` (`source: "excel-manifest"`), put-away task
     `null → pending`.
4. In `createCnExcelUploads`: accept `mode` per file — branch to
   `insertCnManifestOrderTx` for `"manifest"`, `insertCnExcelOrderTx`
   otherwise; the workflow tracking row + workflow log + single
   `receiving_cn.completed` SSE wrap both branches as today.

**`apps/backend/src/routes/admin/receivingCn.ts`**

5. In the `/receiving-cn/excel` route body mapping: read optional
   `f.mode` (`"manifest"` only accepted value), validate manifest payloads
   with `validateCnManifestPayload`, pass through to `createCnExcelUploads`.

## Step 2 — Backend tests

**`apps/backend/src/routes/admin/receivingCn.test.ts`**

- Manifest submit (2 invoice groups, mixed org prefixes): assert 1 order
  (`status in_hand`, `arrived_at` set, `batch_no = REF-YYYYMMDD`), 2 invoice
  rows with real INVOICE NOs + totals, items `received_qty = line_qty`,
  put-away task exists with the uniform pair, tracking row `completed` with
  payload, transaction logs + SSE row.
- batch_no collision: pre-create an order with the same `REF-YYYYMMDD` →
  second upload gets `-2`.
- All-or-nothing: manifest file + TE file in one submit where the TE file
  fails validation → no rows at all.
- TE regression: existing confirmation-entry test still passes (pending, no
  put-away task).

## Step 3 — Admin client: draft model + wire mapping

**`apps/admin/utils/cnReceivingExcel.ts`**

6. `CnReceivingItem` gains optional `invoiceNo`; `parseCnManifestAoa` stamps
   it on every row (and keeps the per-group split it returns today).
7. `CnReceivingDraft` gains `mode: "confirmation" | "manifest"` (default
   `"confirmation"`).
8. `checkCnDraft`: skip `noInvoiceNo` when `mode === "manifest"`.
9. `cnDraftToEntry`: manifest drafts → `{ filename, mode: "manifest",
   payload: { receiptNo, receivedDate, receivedOffice?, invoices: groups
   mapped from item.invoiceNo (invoiceNo, totalQty, totalCtn via the existing
   merge-aware carton count, items stripped of client-only fields) } }` with
   NO `brand`.

**`apps/admin/tests/cnReceivingExcel.test.ts` / `cnReceivingExcelExport.test.ts`**

10. Manifest fixture decodes to items tagged per invoice; draft→wire mapping
    emits the manifest shape (34 groups for the CSZ00 fixture); TE fixtures
    unchanged.

## Step 4 — Admin client: upload page

**`apps/admin/pages/receiving-cn/new.vue`**

11. `addExcelDraft`: manifest fallback builds ONE draft for the file
    (`mode: "manifest"`, shared header, flat items) instead of N tagged
    drafts; confirmation path unchanged.
12. `gateAndAutoCreate` per draft:
    - `mode === "manifest"` → any issue (including `invalidQty`, which today
      opens step 2) becomes a blocking error banner + the draft is dropped
      (message says fix the sheet/parts master and re-upload); no step 2, no
      brand prefill.
    - confirmation → existing behavior verbatim.
13. `submitExcelDrafts` unchanged (mixed drafts ride one request,
    all-or-nothing).

## Step 5 — Verify

- `pnpm --filter @warehouse/backend test` and
  `pnpm --filter @warehouse/admin test` (or the repo's admin test runner).
- `pnpm --filter @warehouse/backend build` typecheck.
- Manual: `pnpm dev:backend` + `pnpm dev:admin` — upload
  `supporting_doc/cn_receiving/CSZ00-manifest-20261102.xls` → one
  `CSZ00-<today>` order, 34 invoices, in PDA CN put-away list immediately;
  upload `TE20261010-2.xls` → unchanged pending order with scan chain.

## Step 6 — Docs + UAT

14. Update `docs/app-docs/flows/<cn-receiving>/overview.md` + `steps.md` +
    `ai-scope.md` and `docs/app-docs/ai/feature-registry.md` for the split
    behavior (manifest: 1 order N invoices, no scan; TE: unchanged).
15. Follow-up note on specs 2026-11-08 / 2026-11-10 pointing at the new spec.
16. If the function surface changed for testers, adjust
    `docs/uat/functions.json` (ADM-023 description only — id stays) and
    regenerate the tracker if needed.
