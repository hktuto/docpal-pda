# CN put-away — scan a carton QR to drive box-by-box put-away

Date: 2026-11-18 · App: pda · Function: PDA-013 (put-away)
Builds on: `2026-11-08-receiving-cn-excel-local-upload-design.md`,
`2026-11-10-receiving-cn-truck-manifest-upload-design.md`,
`2026-11-17-receiving-cn-manifest-single-order-design.md`
(verified against warehouse_sz clone, invoices GZ-26110068 / SZ-26110077)

## Problem

A CN (HK-style) order is one order per INVOICE NO, and one invoice spans
several physical cartons (`receiving_invoice_items_cn.ctn_no`). Today the CN
put-away page (`apps/pda/pages/put-away/[id].vue`, `cnMode`) only supports
free scans: an item label (or supplier carton barcode) stages pieces with no
notion of which physical carton the operator is working. Warehouse staff work
carton by carton: they pick up one box, want to see exactly what is inside
it, put each item onto a shelf, then move to the next box. Without box
targeting they must read the paper packing list and hunt the item list.

## The carton QR

Each carton carries a printed QR label with this payload (verified on real
prints):

```
0;SZ-26110077;1;2;6;KOA+RK73H1ETTP 1000F;24;18;2F;14;15;2002F;14;10;JTTD 1200F;53;15;49R9F;25;9;2ATTD 5101F;53;Made In China;
```

Split on `;` and trimmed:

| Field | Value | Meaning |
|---|---|---|
| 1 | `0` | constant — ignored |
| 2 | `SZ-26110077` | **invoice no** (`receiving_invoices_cn.invoice_no`) |
| 3 | `1` | **box seq** — 1-based index of this carton |
| 4 | `2` | **total boxes** on the invoice — display only |
| 5 | `6` | item count in this box — display only, **ignored by the UI** (the DB is authoritative; on SZ-26110077 box 1 it equals the line count of ctn 25, but nothing depends on it) |
| 6… | `KOA+…;Made In China` | per-item tail + origin — **never parsed**, the box contents come from the DB |

### Box targeting rule (verified against warehouse_sz)

1. Find the put-away task's order by matching field 2 against the order's
   `receiving_invoices_cn.invoice_no` values.
2. Take that invoice's items' distinct `ctn_no` values, filter to numeric
   ones, sort **numerically** (`ctn_no` is text; '10' must not sort before
   '2').
3. Field 3 (1-based) indexes into that sorted list — that `ctn_no` is the
   box.

Real-data proof:

| Scanned | Invoice ctn_no (sorted) | Resolves to |
|---|---|---|
| `0;GZ-26110068;1;4;6;…` | 38, 39, 40, 41 | **ctn 38** (box 1 of 4) |
| `0;SZ-26110077;1;2;6;…` | 25, 26 | **ctn 25** (box 1 of 2, 6 lines) |

## Decision

**Box-driven put-away dialog, client-side over the existing aggregate.**
`GET /put-away-cn/tasks/:id` already returns every item with `ctnNo`; the
only backend change is adding `invoiceNo` to those rows so boxes resolve
per-invoice when an order carries several invoices (the dialog's item source
stays the DB — `receiving_invoice_items_cn` — never the QR tail).

Flow on the PDA put-away detail page (CN mode only):

1. **Scan the carton QR** with the hardware scanner (the page's wedge/
   hardware pipeline — the camera flow on this page is per-group review and
   is not a box entry point). `parseCnBoxQr` (new `utils/cnBoxQr.ts`)
   validates the
   grammar: ≥ 6 semicolon fields, field 1 numeric, field 2 an invoice-ish
   token, fields 3–5 positive integers, `boxSeq ≤ totalBoxes`. Anything else
   falls through to the existing item-label path untouched.
2. **Box dialog opens** (`components/put-away/CnBoxDialog.vue`): invoice no,
   `Box {ctn_no}` + `({seq}/{total})`, and the box's lines — part no, WCL
   item no, line qty, remaining (net of locally staged pieces), suggested
   shelf. Fully-put-away lines render struck through.
3. **Select an item** — either scan its part label (decoded via the existing
   `parseRawValue`; the match + COO/COW guard mirrors `handleCnItemScan`,
   restricted to the box's lines; the label qty becomes the staged qty) or
   tap the row (staged qty = that line's remaining in the box). The selected
   row highlights.
4. **Scan a shelf** — stages the selected item onto that shelf as one CN
   piece with `boxId = ctn_no` (the staging struct + `POST
   /put-away-cn/tasks/:id/complete` already carry `boxId` through to the
   inventory lot's `box_id` — previously always null), then clears the
   selection for the next item. A shelf scan with nothing
   selected toasts "select an item first" (it does not fall through to the claim
   path). Closing the dialog at any time leaves already-staged pieces in the
   pending list; the existing batch commit button is unchanged.
5. **Scan another carton QR** while the dialog is open switches the dialog
   to the new box.

Out of scope / untouched: the standard (non-CN) put-away path, the
free-scan CN path (box QR is additive — anything the parser rejects flows
exactly as today), commit semantics, allocation.

## Ceilings

- Orders whose items have non-numeric `ctn_no` cannot be box-targeted (the
  sort is numeric by decision — `ctn_no` is always numeric in this flow);
  the scan toasts `box_not_found` and the operator keeps using free scans.
- A QR whose invoice is not on the current task toasts `box_wrong_order`.
- `boxSeq` beyond the invoice's carton count toasts `box_not_found`.
- The QR tail is never parsed: a carton label that lies about its contents
  is caught the same way it is today — at the item scan / mismatch review.

## Files

- `apps/pda/utils/cnBoxQr.ts` — parser + `resolveCnBox` (pure functions).
- `apps/pda/components/put-away/CnBoxDialog.vue` — presentational dialog.
- `apps/pda/pages/put-away/[id].vue` — scan routing (box QR → dialog;
  dialog item/shelf scans), `boxId` on staged pieces.
- `apps/backend/src/db/putawayCn.ts` — add `invoice_no AS "invoiceNo"` to
  the CN task-detail items + type field.
- `apps/pda/services/types.ts` — `PutAwayExpectedItem.invoiceNo?: string | null`.
- `apps/pda/services/adapters/backendWarehouse.ts` — map the new field.
- `layers/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — `putAway.cn.box.*` strings.

## Verification

- `apps/pda/tests/cnBoxQr.test.ts` — parser grammar (both real payloads,
  rejections: shelf codes, `BOX-*`, item labels, short payloads,
  `boxSeq > totalBoxes`) and resolver (GZ → 38, SZ → 25, multi-invoice
  scoping, out-of-range, done-lines-still-resolve).
- `pnpm --filter @warehouse/pda test`, `pnpm --filter @warehouse/pda build`.
- `pnpm --filter @warehouse/backend test` (putawayCn aggregate shape) +
  `build`.
- Manual against warehouse_sz: open the CN put-away task for
  GZ-26110068 (`01a1eddb-6d48-74db-bf71-f18c71beb306`), scan
  `0;GZ-26110068;1;4;6;KOA+RK73H2ATTD 8202F…` → dialog shows ctn 38's four
  lines; scan/tap `RK73H2BRTTD 5103F` → scan shelf `A-01` → staged piece
  carries boxId 38; commit.
