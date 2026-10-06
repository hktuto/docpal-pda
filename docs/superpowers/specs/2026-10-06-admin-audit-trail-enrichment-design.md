# Admin audit-trail enrichment: lot history + receiving put-away audit — design

Date: 2026-10-06

The backend already records a rich stock-movement ledger
(`inventory_transactions`: lot, shelf, box, qty delta, actor, order
references — `apps/backend/src/db/schema/audit.ts`) but exposes none of it:
admin users answering "who put this on the shelf / who took from this lot /
where did this lot come from" need direct DB access. This spec adds the
read APIs and admin UI surfaces, and fixes the small write-side gaps that
would make those answers incomplete.

Scope (three parts, all admin-facing; no operator/PDA change):

1. **Per-lot history API + stock-search drill-down.**
2. **Receiving-order audit enrichment** — put-away events in the order's
   log view.
3. **Ledger write-gap fixes** — missing `actor_id` on three admin actions,
   and read-side resolution of the destination shipping box for picks.

Non-goals: no ledger schema change; no SHIP_CONFIRM ledger rows; no
timeline redesign of `AuditLogTable`; no PDA change.

## 1. Lot history

### Backend

New `GET /admin/inventory-lots/:id/history` (`src/routes/admin/issues.ts`,
domain fn `listLotHistory` in a new `src/db/lotHistory.ts`):

- 404 `lot_not_found` when the lot id is unknown.
- Response:

```jsonc
{
  "lot": { "id", "partNo", "wclItemNo", "dateCode", "lotCode",
           "coo", "cow", "shelfCode", "boxId", "orgId", "subInventoryCode",
           "totalQty", "allocatedQty", "createdDate" },
  "sources": [                           // inventory_lot_sources → origin
    { "receivingInvoiceItemId", "receivingOrderId", "batchNo", "partNo",
      "qty", "createdDate" }
  ],
  "movements": [                         // inventory_transactions, oldest first
    { "id", "txnType", "qtyType", "qtyDelta", "shelfCode", "boxId",
      "dateCode", "lotCode", "coo", "cow", "referenceType", "referenceId",
      "receivingInvoiceItemId", "actorId", "actorName", "txnReason",
      "metadata", "txnAt" }
  ]
}
```

- `movements` is filtered `inventory_lot_id = :id`, ordered by `txn_at`
  ascending. Rows whose lot id was nulled by a lot merge are **not**
  recoverable per lot (known limitation, documented below).
- Reference enrichment (read-side joins, no schema change):
  - `reference_type = 'picking_item'` → join `picking_items` for
    `pickingOrderId`/`orderNo`, and `picking_packages` (by source lot +
    picking item) for the destination `shippingBoxId` — this is how
    "picked into box X" is answered without a ledger schema change.
  - `reference_type = 'receiving_order'` → `batchNo`.
  - `reference_type = 'goods_verify_task'` → task id as-is.
- Admin-only (JWT + admin group), consistent with the sibling
  `/admin/*-orders/:id/logs` routes.

### Admin UI

`pages/stock-search.vue`: each lot row gains a history action (🔍 button in
the row actions / part cell). Opens a modal (`components/stock-search/LotHistoryModal.vue`):

- Header: part no + batch fields + current shelf/box/qty.
- **Origin** section: source receiving orders/items (batch no, qty, date).
- **Movements** table: time, actor, type (RECEIVE_TO_DOCK / PUT_AWAY / PICK /
  RESERVE / ADJUST), qty delta (+/− colored), shelf/box, reason, and the
  resolved target (picking order no + shipping box, receiving batch no).
- Plain CSS, `SearchableSelect`-era conventions; data fetched from the new
  endpoint via `flowApi` (add `listLotHistory`).

## 2. Receiving-order audit enrichment

`GET /admin/receiving-orders/:id/logs` currently returns only
`transaction_logs` rows for the order + its invoice items; put-away events
(shelf/box/actor) land in the ledger against `shelf_box` entities and are
invisible here. Change:

- `listReceivingOrderLogs` additionally returns the order's `PUT_AWAY`
  ledger rows — those whose `receiving_invoice_item_id` belongs to the
  order — as a separate `putAway` array:

```jsonc
{ "rows": [ …transaction_logs, as today… ], "total": n,
  "putAway": [ { "itemId", "partNo", "wclItemNo", "qty", "shelfCode",
                 "boxId", "actorId", "actorName", "lotId", "createdDate" } ] }
```

- Admin receiving detail page: the audit section gets a **Put-away**
  sub-table (time, item part no, qty, shelf, box, actor) above/under the
  existing transition log. Purely additive; existing `rows` shape untouched.

## 3. Ledger write-gap fixes

In `src/db/allocate.ts` and `src/db/picking.ts`, add the missing `actorId`
to the ledger rows for the admin actions where it is currently only on the
companion `transaction_logs` row:

- `admin: remove allocation` (`removePickingAllocation`)
- `admin: override steal` (status-override steal path)
- `admin: manual allocation` (`addManualPickingAllocation`)

The destination shipping box is **not** added to PICK ledger rows; it is
resolved read-side in the lot-history endpoint (§1) via
`picking_packages`.

## Known limitations (documented, accepted)

- Lot merges null `inventory_lot_id` on historical ledger rows — pre-merge
  history is then only visible under the surviving lot's id.
- Recompute-engine rows (reserve/release/perfect-match) legitimately have no
  actor (background job); they show as "system".
- Verify re-scans and package boxing/reopen remain transition-log-only (no
  stock movement), so they appear in order logs, not the ledger.

## Docs

- `docs/backend/api-design.md` — document the new endpoint + the extended
  logs response.
- `docs/backend/schema-tables.md` — note the read API for
  `inventory_transactions`.
- `docs/app-docs/` — update the stock-search flow's `ai-scope.md` /
  `ai/code-map.md` for the new modal + endpoint.
