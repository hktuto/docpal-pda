# Shipper HCC (supplier 23) drawing-no variant — design

Date: 2026-09-21
Status: proposed
Builds on: 2026-09-21-admin-excel-export-renderer-separation-design.md

## Problem

For supplier **HCC (`supplier_code` = `"23"`)**, the shipper's first column
must show the item's **drawing number** instead of the invoice number:

- header `Invoice / Ctn` → `Drawing No / CTN`
- cell value `"{invoice_no} {ctn_no}"` → `"{drawing_no} {ctn_no}"`, where
  `drawing_no` comes from
  `receiving_invoice_items.additional_data->>'drawing_no'` (unstructured
  upstream passthrough; absent → the column shows just the ctn_no, or blank
  — no fallback to invoice_no).

Everything else about the shipper (blocks, slots, totals, both live and
finished modes) is identical. This is the first real consumer of the
renderer registry.

## Decisions

- **Config-style variant, not a fork** (per `src/export/README.md` rule
  "config before forks"): the only differences are one header label and one
  field choice. `render/default.ts` exports a factory
  `makeShipperRenderer(options?)` with
  `firstColumnHeader` (default `"Invoice / Ctn"`) and `firstColumnField`
  (`"invoiceNo"` | `"drawingNo"`, default `"invoiceNo"`); the default
  renderer is the factory with no options.

- **The model carries components, not a pre-composed string.**
  `ShipperGroup.blockItems` changes from `{ invoiceCtn, qty }` to
  `{ invoiceNo, drawingNo, ctnNo, qty }` (all nullable except qty), and the
  `"{x} {ctn_no}"` join moves into the renderer. Rationale (registry rule):
  a layout needing a field the model lacks → add it to the shared model,
  never fork `data.ts`. `data.ts` gains one select column:
  `rii.additional_data->>'drawing_no' AS "drawingNo"`.

- **Registration.** New `render/hcc.ts`:
  `registerRenderer("shipper", makeShipperRenderer({ firstColumnHeader: "Drawing No / CTN", firstColumnField: "drawingNo" }), { supplierCode: "23" })`,
  imported for its side effect in `src/routes/admin/receivingShipper.ts`
  next to the default import. The route already resolves with
  `{ supplierCode: doc.head.supplierCode }` — no route logic change.
  Applies to both live and `?mode=finished` shippers (same head/scope).

- **`"(order-level)"` closing blocks are unchanged** — they carry no
  carton/invoice value.

## Testing

- Existing `receivingShipper.test.ts` cases keep passing (default layout
  unchanged — `makeShipperRenderer()` reproduces today's bytes).
- New case in `receivingShipper.test.ts`: receiving order with
  `supplier_code = "23"` and an item whose `additional_data` carries
  `drawing_no`; assert the header cell reads `Drawing No / CTN` and the
  carton row shows `"{drawing_no} {ctn_no}"`. A non-HCC order in the same
  test run still renders `Invoice / Ctn` (registry scoping).
