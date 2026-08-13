# Ingest caller-supplied ids + whole-order DELETE

Date: 2026-08-13
Status: approved, implemented

Two extensions to the server-to-server ingest API (`src/db/ingest.ts`,
`src/routes/ingest.ts`), driven by the DocPal sync: DocPal needs its own
stable UUIDs on the rows it pushes (so it can reference warehouse rows without
a follow-up read), and it needs to cancel an order it pushed by mistake
(whole-order delete).

## 1. Caller-supplied UUIDs on create

Every insert level of both ingest payloads gains an optional `id?: string`:

- `IngestReceivingBody.order.id`, `IngestReceivingInvoice.id`,
  `IngestReceivingItem.id`
- `IngestPickingBody.order.id`, `IngestPickingItem.id`

Rules:

- **INSERT path only** (no existing row for the natural key `batch_no` /
  `order_no`): the supplied id is used instead of `newId()` (UUID v7) for the
  order, each invoice, and each item.
- **Validation:** a supplied id must be a non-empty string matching a
  permissive UUID shape (`8-4-4-4-12` hex) — otherwise 400 `invalid_id`.
- **Collision:** if a supplied id already exists as the PK of a *different*
  row (different natural key), a cheap `SELECT` pre-check per level (order /
  invoice / item) throws 409 `id_already_exists` instead of surfacing a raw PK
  violation.
- **Reconcile path:** a supplied `id` on an existing natural key is **ignored**
  — reconcile stays keyed by the natural keys (invoices by `invoice_no`,
  receiving items by `part_no+po_no+po_line`, picking items by `part_no`), and
  the row keeps its server-assigned id. Responses keep the existing
  `{id, created, changed}` shape.

## 2. Whole-order DELETE endpoints

- `DELETE /receiving-orders/:batchNo` → `deleteReceivingOrder(db, batchNo)`
- `DELETE /picking-orders/:orderNo` → `deletePickingOrder(db, orderNo)`

Guards (mirroring the existing reconcile guards):

- 404 `not_found` — no order with that natural key.
- 409 `cannot_delete_once_<status>` — order is past `pending`.
- 409 `cannot_delete_after_work_started` — any line has work started
  (receiving: `received_qty`/`picked_qty`/`put_away_qty` > 0, allocation
  links, or `receiving_scan_labels` rows; picking: `picked_qty` > 0 or
  allocation links). Pending + no-work-started implies nothing downstream
  exists, so the guard covers the cascades.

On success the order row is deleted; children cascade
(`receiving_invoices`/`receiving_invoice_items`/`receiving_scan_labels`/
`allocations.receiving_order_id`/`put_away_tasks`, and
`picking_items`/`picking_packages`/`allocations` respectively — all
`onDelete: "cascade"` in the schema). Picking `priority_seq` is **not**
compacted — gaps are harmless (ordering is by seq value).

An outbox event is emitted in the same tx (`receiving_order.deleted` /
`picking_order.deleted`, topics `["/receiving-orders"]` /
`["/picking-orders"]`, data `{id, batchNo}` / `{id, orderNo}`), the response
is `{id, deleted: true}` (200), and `allocateAll(db)` runs best-effort after
commit — deleting a dock-stock source or a demand changes allocation.
