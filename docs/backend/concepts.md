# Backend — Key Concepts

This document describes the key concepts of the warehouse management backend
(`apps/backend` + the `apps/admin` console). Where a concept is not yet enforced
in code, it is marked **[planned]** — the backend is being built out
incrementally, and these concepts are the design intent.

## 1. What the app is

A warehouse management system (WMS) for the PDA workflows: receiving → put-away
→ picking → measuring → goods verify, on top of a stock ledger. `apps/backend`
is the API (Hono + Drizzle + PostgreSQL); `apps/admin` is the desktop console
for master data; the PDA client connects to the same API.

## 2. Receiving order structure

A **receiving order** is a batch (packing-list batch). It is made of **multiple
invoices** (`receiving_invoices` — the packing-list header), and each invoice
has **multiple line items** (`receiving_invoice_items` — the packing-list
lines, one per part/PO line).

```
receiving_orders 1──N receiving_invoices 1──N receiving_invoice_items
```

## 3. Stock is partitioned by the pair org_id + sub_inventory_code

The app runs one standalone instance per warehouse (no `warehouse_code`).
Stock and stock-affecting documents are stamped with a location pair:

```
org_id (integer office, e.g. 2 = HK) + sub_inventory_code (e.g. STORE1)
```

- `org_id` — the office/organization the stock belongs to (plain integer, no
  lookup table). `NOT NULL DEFAULT 2` on the receiving tables; nullable
  elsewhere.
- `sub_inventory_code` — the store the goods go into (`sub_inventories`
  lookup; its own `org_id` anchors which org the sub-inventory belongs to). A
  customer may request their goods be stored separately
  (`sub_inventories.customer_code`). On receiving orders it is mandatory
  (`NOT NULL`); on `picking_orders` and `inventory_lots` it is nullable.

The pair rides together on `shelves`, `receiving_orders`,
`receiving_invoices`, `receiving_invoice_items`, `picking_orders`, and
`inventory_lots`, and both columns are part of the
`inventory_lots_unique_lot` identity — the same lot tuple can exist
independently per org / sub-inventory. Allocation matches demand to sources
on the pair (a NULL on the picking order side matches anything); sources in a
customer-segregated sub-inventory only serve that customer's orders.

## 4. Date-code fallback from order to items

A receiving order may carry a **date code** for the whole batch
(`receiving_orders.date_code`). When an invoice item does not provide its own
`date_code`, the item inherits the receiving order's date code. (Applied by
`confirmReceivingArrival` in `apps/backend/src/db/receiving.ts` — the fallback
materializes on the item rows at confirm-arrival time.)

## 5. Allocations are computed when the order is confirmed in-hand

While a receiving order is `pending` it is only an expectation. Once the user
confirms the order **in-hand** (`POST /receiving-orders/:id/confirm-arrival`),
the system (re)calculates **allocations**: pending picking demand is matched
against what is actually available. The recompute runs **after** the arrival
transaction commits and is best-effort — an allocation failure must never roll
back a confirmed arrival.

## 6. Allocation strategy: stock first, then receiving orders **[planned]**

Allocation sources, in priority order:

1. **Stock first** — `inventory_lots` on shelves (`allocations.inventory_lot_id`).
2. **Receiving orders** — quantities expected from receiving
   (`allocations.receiving_invoice_item_id`):
   - If the receiving line has a **`box_id`**, the allocation is marked down to
     **that box** (box-level granularity — `receiving_invoice_items.box_id`).
   - If the line has **no `box_id`**, the allocation is marked against the
     **whole receiving order** (`allocations.receiving_order_id`).

Selection rules (confirmed with the business):

- **Date-code rule** — if the demand carries a date-code requirement, sources
  must satisfy it; otherwise plain FIFO. Source precedence: picking item's
  `required_date_code` → picking order's `required_date_code_notice` →
  customer profile remark (e.g. "less than 2 years" / "more than 2 years"
  relative to today). Forms: `2601` exact, `2601+`, `2601-`, year-relative.
- **Location match** — sources must match the picking order's
  `warehouse_code`, `warehouse_section_code` (when set) and
  `sub_inventory_code` (when set).
- **FIFO** — oldest `date_code` first (NULLS LAST).

> Implementation: `apps/backend/src/db/allocate.ts` (`allocateAll`) — full
> idempotent recompute (wipes and rebuilds open items' allocations with
> RESERVE ledger rows); `POST /dev/allocate` triggers it manually and
> confirm-arrival calls it automatically. Receiving
> sources are `in_hand` / `provisional_received` orders only. The engine and
> the confirm-arrival trigger exist; the remaining picking/receiving flows
> that call it are planned.

## 7. Goods-verify tasks are generated at day end

Goods verify is a daily cycle count: at the end of every day, the system
generates a new goods-verify task for **every stock item that was created or
updated that day** — i.e. every location/lot with movement in
`inventory_transactions` (the ledger exists precisely to answer "which shelves
had in/out records yesterday").

The tasks live in **`goods_verify_tasks`** — one row per
`(task_date, inventory_lot_id)` (the day's movements on a lot collapse into a
single task), carrying `shelf_code` and `box_id` because put-away/verify is
box-based (each shelved box has a printed label). The operator works the day's
pending tasks box by box; `expected_qty` is the stock snapshot at generation
time.

> Implementation: `apps/backend/src/db/goodsverify.ts` +
> `src/routes/goodsverify.ts`. `POST /goods-verify-tasks/generate` inserts one
> pending task per distinct lot moved in `inventory_transactions` on the given
> date (default: the DB server's `CURRENT_DATE`; `txn_at` holds UTC
> wall-clock), `ON CONFLICT DO NOTHING` on the unique index so re-runs are
> idempotent. `GET /goods-verify-tasks` is the work queue (date/status/shelf
> filters, part identity joined); `GET /goods-verify-tasks/:id` adds the lot
> and the shelf box with its items. `POST /goods-verify-tasks/:id/verify`
> marks the task `verified`; a `countedQty` mismatch corrects the lot's
> `total_qty` and writes an ADJUST (`on_hand`) ledger row (guarded so
> `available_qty` never goes negative) followed by a best-effort allocation
> recompute, and a task with a box marks the box's items verified and
> transitions the box `closed → verified` (an open box is rejected — put-away
> may still be in progress).
