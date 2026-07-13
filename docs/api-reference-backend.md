# Warehouse API Reference

> HTTP API served by `apps/api` (Hono on Node, better-sqlite3). Default base URL: `http://localhost:3001` (`PORT` env overrides). Schema: `docs/database-schema-api.md`.

## Conventions

- **Body/response fields are `snake_case`.** Types shared with the web app live in `packages/shared/src/index.ts`.
- **No authentication on requests.** `POST /auth/login` verifies credentials and returns the user object; there are no tokens or sessions. Mutations that record an actor take `actor_id` (a `users.id`) in the JSON body or as a query parameter — it is optional everywhere except the mismatch and picking-issue endpoints.
- **Errors:** non-2xx responses carry a plain-text body with the message. Validation messages sometimes use i18n-style keys (e.g. `unhandled_issue_reason`, `mismatch_reason_required`) shared with the web app.
- **Timestamps** are ISO 8601 UTC strings; **ids** are UUIDs. Orders additionally have an ingest-supplied unique `external_id`.
- **CORS:** `http://localhost:3000`, `http://localhost`, `capacitor://localhost` (override with `CORS_ORIGINS`).
- All mutations run in a SQLite transaction. Allocation (`db/allocate.ts`) runs best-effort after receiving/picking upserts — it never rolls back the committed change.

## System & auth

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness + DB check. `200 { ok: true, db: "ok" }`, or `500 { ok: false, db: "error" }`. |
| POST | `/auth/login` | Body `{ username, password }` → `200 AuthUser { id, username, name, role }`. `400` missing fields, `401` invalid credentials. Demo parity: plain-text password compare. |
| GET | `/auth/users/:id` | → `200 AuthUser`. `404` user not found. |
| POST | `/dev/reset` | Wipes the sqlite database and re-seeds from `db/seedSql.ts` → `200 { ok: true }`. |

## Receiving

### `GET /receiving-orders`

Query: `status?` (`pending|in_hand|clear`).

→ `200` array, ordered by `delivery_date`:

```jsonc
[{ "id", "ref_no", "status", "delivery_date", "supplier_name",
   "remaining_items",        // items with available_qty minus unboxed put-away scans > 0
   "pending_picking_orders"  // distinct open picking orders allocated to this order
}]
```

### `GET /receiving-orders/:id`

→ `200`:

```jsonc
{
  "id", "ref_no", "status", "delivery_date", "remaining_items",
  "allocated_by_item": { "<receiving_invoice_item_id>": qty },  // allocation split per item
  "supplier": { "id", "code", "name", "qr_template", "qrcode_qty_encoding" } | null,
  "invoices": [{
    "id", "receiving_order_id", "invoice_no", "supplier_id",
    "items": [{
      "id", "receiving_invoice_id", "part_id", "qty", "received_qty", "picked_qty",
      "put_away_qty", "box_id", "date_code", "lot_code", "coo", "cow",
      "part": { "id", "part_no", "description" } | null,
      "mismatch": { /* latest non-cancelled receiving_item_mismatches row */ } | null
    }]
  }]
}
```

`404` order not found.

### `GET /receiving-orders/:id/scan-candidates`

Scan-matcher snapshot for OCR/QR label matching (powers the web's `useScanMatchers`). While the order is not `in_hand`, returns `200 { receiving_by_part_no: {}, picking_by_part_id: {} }`.

→ `200`:

```jsonc
{
  "receiving_by_part_no": {   // key: collapseUpper(part_no) — no confusable mapping
    "<KEY>": [{ "receiving_invoice_item_id", "part_id", "part_no",
                "date_code", "lot_code", "coo", "cow",  // stored *_norm values
                "available_qty" }]                       // minus unboxed put-away scans
  },
  "picking_by_part_id": {     // picking orders allocated to this receiving order
    "<part_id>": [{ "picking_order_id", "picking_order_ref_no", "picking_item_id",
                    "part_id", "ship_to", "required_qty", "picked_qty", "remaining_qty" }]
  }
}
```

`404` order not found.

### `GET /receiving-orders/:id/picking`

Picking view of a receiving order — one row per allocation (lot allocations resolved through `inventory_lot_sources`, plus direct receiving-order allocations).

→ `200 { rows, packages_by_item, boxes_by_order, transition_logs }`:

- `rows[]`: `{ picking_order_id, picking_order_ref, picking_order_status, picking_order_ship_to, picking_item_id, required_qty, picked_qty, allocation_id, allocated_qty, part_id, part_no, shelf_code, box_id, date_code, lot_code, coo, cow, scanned_qty, boxed_qty }` (location/lot fields are NULL for direct receiving-order allocations).
- `packages_by_item`: `{ "<picking_item_id>": [picking_packages rows] }` — all packages for the involved items.
- `boxes_by_order`: `{ "<picking_order_id>": [{ id, picking_order_id, status }] }`.
- `transition_logs`: `{ "<picking_order_id>": [transition_logs rows + actor_name] }` (newest first).

`404` order not found.

### `POST /picking-items/transition-logs`

Body `{ ids: string[] }` (non-empty) → `200 { logs: [transition_logs rows + actor_name] }` for `entity_type = 'picking_item'`, newest first. `400` invalid body.

### `PUT /receiving-orders/:external_id`

Ingest upsert of a receiving order with its invoices and items. Body (`ReceivingPutBody`):

```jsonc
{
  "order": { "ref_no", "delivery_date"?, "supplier_code"? },
  "invoices": [{
    "invoice_no", "supplier_code"?,   // falls back to order supplier_code
    "items": [{ "line_no": int, "part_no", "description"?, "qty": int >= 0,
                "box_id"?, "date_code"?, "lot_code"?, "coo"?, "cow"?" }]
  }]
}
```

Parts are resolved/created by `part_no_norm`; new parts (or parts with NULL supplier) pick up the invoice's supplier. Unknown `supplier_code` → `400`. On an existing order, lines are reconciled: qty may only increase once the order is no longer `pending`, and worked lines cannot shrink/disappear (`409`).

→ `201 { id, external_id, created: true, changed }` on create, `200` with `created: false` on update. Triggers best-effort allocation after confirm-arrival only (not on upsert).

### `POST /receiving-orders/:external_id/confirm-arrival`

`:external_id` accepts either the internal `id` or the ingest `external_id`. Sets the order `pending → in_hand`, applies expected qty to every item's `received_qty`/`available_qty`, logs the transition, then runs best-effort `allocateAll`.

→ `200 { id, status: "in_hand" }`. `404` not found, `409` not in `pending`.

## Picking

### `GET /picking-orders`

Query: `status?`, `updated_since?` (ISO timestamp; `updated_at > since`).

→ `200` array (unfinished first, then by delivery date):

```jsonc
[{ "id", "external_id", "ref_no", "status", "ship_to", "destination_country",
   "delivery_date", "created_at", "updated_at", "supplier_name", "total_qty" }]
```

### `GET /picking-orders/:id`

→ `200`:

```jsonc
{
  "order": { /* picking_orders row + po_no, required_date_code_notice, issue_* fields,
              issue_reported_by_name, supplier_id/code/name/qr_template/qrcode_qty_encoding */ },
  "measuring_task": { "id", "status" } | null,
  "items": [{ "id", "part_id", "part_no", "qty", "picked_qty", "scanned_not_boxed_qty",
              "remaining_qty", "allocated_qty", "line_id", "required_date_code", "source_shelf_code" }],
  "allocations": [{ "id", "picking_item_id", "qty", "remark", "inventory_lot_id",
                    "receiving_order_id", "receiving_order_ref_no",
                    "lot": { /* inventory_lots row incl. *_norm */ } | null,
                    "receiving_items": [{ "receiving_invoice_item_id", "qty", "invoice_no",
                                          "box_id", "date_code_norm", "lot_code_norm",
                                          "coo_norm", "cow_norm" }] }],
  "packages": [{ "id", "picking_item_id", "source_type", "source_id", "qty",
                 "shipping_box_id", "date_code", "lot_code", "coo", "cow", "verified", "created_at" }],
  "boxes": [{ "id", "status", "box_size", "net_weight_g", "gross_weight_g",
              "destination_country", "created_at", "updated_at" }]
}
```

`404` order not found.

### `PUT /picking-orders/:external_id`

Ingest upsert of a picking order with its items. Body (`PickingPutBody`):

```jsonc
{
  "order": { "ref_no", "ship_to"?, "destination_country"? },
  "items": [{ "line_id", "part_no", "qty": int >= 0,
              "required_date_code"?, "source_shelf_code"?" }]
}
```

Lines are reconciled by `line_id`; qty cannot drop below `picked_qty + scanned_not_boxed_qty` (`409`), worked lines cannot be removed. → `201/200 { id, external_id, created, changed }`. Runs best-effort `allocatePickingOrder` when anything changed.

### `POST /picking-orders/report-issues`

Batch issue report. Body `{ picking_order_ids: string[], reason, qty?, pack_size?, remark?, actor_id }`:

- `actor_id` required (`400`); `reason` ∈ `insufficient_stock|cannot_divide|merge|other` (`400 unhandled_issue_reason`).
- `merge` requires ≥ 2 orders (`400 select_at_least_two_orders_to_merge`); `insufficient_stock` requires `qty >= 0` (`400 actual_quantity_required`); `cannot_divide` requires `pack_size > 0` (`400 pack_size_required`).

→ `200 { reported: string[], skipped: string[] }`.

### `POST /picking-orders/:id/ocr-pick`

**`:id` is the RECEIVING order id** (the scan sources from this receiving order into a picking item). Body (`ApplyOcrPickRequest`) `{ picking_item_id, qty, date_code?, lot_code?, coo?, cow?, actor_id? }` — date/lot/origin fields are informational only; allocation is FIFO.

→ `200 { package_ids: string[] }`. `400` missing `picking_item_id`.

### Scan & box execution

Nested routes (parent ids in the path, verified against the child):

| Method | Path | Body / query | Response |
|--------|------|--------------|----------|
| POST | `/picking-orders/:id/scan` | `{ allocation_id, qty, actor_id? }` | `201 { package_ids }`; `404` order/allocation |
| DELETE | `/picking-orders/:id/packages/:package_id` | `?actor_id=` | `200 { ok: true }`; `404` |
| POST | `/picking-orders/:id/boxes` | optional `{ actor_id? }` | `201 { id }` (new shipping box) |
| POST | `/picking-orders/:id/boxes/:box_id/cancel` | `?actor_id=` | `200 { ok: true }`; `404` |
| POST | `/picking-orders/:id/boxes/:box_id/packages` | `{ package_id, actor_id? }` | `200 { ok: true }`; `400`/`404` |
| POST | `/picking-orders/:id/boxes/:box_id/add-all-unboxed` | `?actor_id=` | `200 { packed: n }`; `404` |
| DELETE | `/picking-orders/:id/boxes/:box_id/packages/:package_id` | `?actor_id=` | `200 { ok: true }`; `404` |
| POST | `/picking-orders/:id/finish` | `?actor_id=` | `200 { ok: true }` — sets `finished`, creates the measuring task |

Flat equivalents (parent resolved inside the db layer):

| Method | Path | Body / query | Response |
|--------|------|--------------|----------|
| POST | `/allocations/:id/scan` | `{ qty, actor_id? }` | `201 { package_ids }` |
| POST | `/packages/:id/add-to-box` | `{ box_id, actor_id? }` | `200 { ok: true }` |
| DELETE | `/packages/:id` | `?actor_id=` | `200 { ok: true }` — removes from box if boxed, else deletes the scan |
| POST | `/packages/:id/verify` | `{ actor_id? }` | `200 { ok: true }` |
| POST | `/shipping-boxes/:id/cancel` | `?actor_id=` | `200 { ok: true }` |

## Put-away

### Read

| Method | Path | Response |
|--------|------|----------|
| GET | `/put-away/candidates` | `200` array of `in_hand` orders with remaining put-away work: `{ id, ref_no, status, supplier_name, available_qty, unboxed_qty }` |
| GET | `/receiving-orders/:id/put-away-lots` | `200` per-invoice-item lots with work left: `{ receiving_invoice_item_id, part_id, part_no, date_code, lot_code, coo, cow, total_qty, available_qty, scanned_qty, boxed_qty }` |
| GET | `/receiving-orders/:id/put-away-scans` | `200` scan rows newest-first: `{ id, receiving_invoice_item_id, part_id, qty, date_code, lot_code, coo, cow, shelf_box_id, verified, verified_at, created_at }` |
| GET | `/receiving-orders/:id/shelf-boxes` | `200` boxes (open first): `{ id, receiving_order_id, shelf_code, status, created_at, updated_at, items: [{ part_id, part_no, qty, verified }] }` |

### Write

| Method | Path | Body / query | Response |
|--------|------|--------------|----------|
| POST | `/receiving-orders/:id/shelf-boxes` | `{ shelf_code, actor_id? }` | `201` shelf-box row; `400` missing shelf_code, `404` order/shelf |
| DELETE | `/shelf-boxes/:id` | `?actor_id=` | `200 { ok: true }` |
| POST | `/put-away/scans` | `{ receiving_invoice_item_id, qty, date_code?, lot_code?, coo?, cow? }` | `201` scan row; `400`/`404` |
| POST | `/put-away/scans/:id/remove-piece` | — | `200 { ok: true }` — removes one piece from a scan |
| POST | `/put-away/scans/:id/assign-to-box` | `{ shelf_box_id, actor_id? }` | `200 { ok: true }` — materializes the inventory lot |
| POST | `/shelf-boxes/:id/add-all-unboxed` | `?actor_id=` | `200 { count }`; `409` box not open |
| POST | `/put-away/scans/:id/remove-from-box` | `?actor_id=` | `200 { ok: true }` |
| POST | `/shelf-boxes/:id/close` | `?actor_id=` | `200 { ok: true }` — auto-clears the receiving order when fully put away; `409` box not open or empty |

## Measuring & shipping boxes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/measuring-tasks` | Query `status?`, `since?` → `200` array (limit 200): `{ id, picking_order_id, status, created_at, updated_at, ref_no, supplier_name, total_items, packed_items }` |
| GET | `/measuring-tasks/:id` | `200 { task, order, items, boxes }` — order incl. supplier + QR fields; each box carries its `packages[]`. `404` |
| POST | `/measuring-tasks/:id/complete` | `?actor_id=` → `200 { ok: true }` |
| PATCH | `/shipping-boxes/:id` | Body `{ box_size?, net_weight_g?, gross_weight_g?, destination_country? }` → `200 { ok: true }` |
| POST | `/shipping-boxes/:id/verify-package` | Body `{ package_id, actor_id? }` → `200 { ok: true }`; `400` missing id, `404` package not in this box |
| POST | `/shipping-boxes/:id/close` | `?actor_id=` → `200 { ok: true }` |
| POST | `/shipping-boxes/:id/verify` | `?actor_id=` → `200 { ok: true }` |
| GET | `/shipping-boxes/:id/for-measuring` | `200 { box, order, task, packages }` — `order` is the parent picking order, `task` its measuring task. `404` |

## Verification tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/verification-tasks` | Query `kind?` (`pre_shipment\|cycle_count`), `status?`, `since?`, `due_before?` → `200` array (limit 200): `{ id, kind, status, due_at, picking_order_id, shelf_box_id, created_at, updated_at }` |
| GET | `/verification-tasks/:id` | `200 { task, order, boxes }` — `order` null for cycle counts; `boxes[]` (pre-shipment) carry `packages[]`. `404` |
| POST | `/verification-tasks/:id/complete` | `?actor_id=` → `200 { ok: true }` |

## Goods verify (shelf stock checks)

Note: the API `shelves` table has no `zone` column, so nested shelf objects expose `zone: null`.

| Method | Path | Response |
|--------|------|----------|
| GET | `/shelves` | `200 [{ code }]` |
| GET | `/shelves/with-box-counts` | `200 [{ code, box_count }]` |
| GET | `/shelves/:code/boxes` | `200 [{ id, shelf_code, status, created_at, item_count, verified_count, last_check_at, checked_today }]` (`checked_today` compares against the server's UTC date) |
| GET | `/shelf-boxes/:id` | `200 { id, receiving_order_id, shelf_code, status, created_at, shelf: { code, zone } \| null, receiving_order: { id, ref_no } \| null, items: [{ part_id, part_no, description, qty, verified, verified_at }] }`; `404` |
| POST | `/shelf-boxes/:id/verify-item` | Body `{ part_id, actor_id? }` → `200 { ok: true, verified_count }`; `400` missing part_id |

## Receiving-item mismatches

Reasons (`@warehouse/shared` `mismatchReasons`): `not_found`, `damaged`, `qty_mismatch`, `wrong_part`, `over_shipment`, `quality_rejection`. Statuses: `pending`, `confirmed`, `cancelled`. Validation rules (`validateMismatchInputs`) are shared verbatim with the web app; failures return `400` with i18n keys like `wrong_part_number_required`. All write endpoints require `actor_id` in the body. The effective `received_qty` is applied to the item at report/edit time; confirm/cancel only flip the status (cancel reverts to `previous_received_qty`). Confirm/cancel are `409` unless the mismatch is `pending` and the actor is not the reporter (`only_pending_mismatch_can_be_confirmed`, `reporter_cannot_confirm_own_mismatch`).

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/receiving-invoice-items/:id/mismatch` | — | `200` latest non-cancelled mismatch row, or `null`; `404 receiving_invoice_item_not_found` |
| POST | `/receiving-invoice-items/:id/mismatches` | `{ reason, mismatch_qty?, wrong_part_no?, note?, actor_id }` | `201` mismatch row |
| PATCH | `/mismatches/:id` | `{ reason?, mismatch_qty?, wrong_part_no?, note?, actor_id }` (absent fields unchanged) | `200` mismatch row |
| POST | `/mismatches/:id/confirm` | `{ actor_id }` | `200` mismatch row |
| POST | `/mismatches/:id/cancel` | `{ actor_id }` | `200` mismatch row |

## Stock search

| Method | Path | Response |
|--------|------|----------|
| GET | `/stock-search/suppliers` | `200 [{ id, code, name, total_parts, parts_with_inventory }]` — supplier↔part linkage derived from receiving history (`receiving_invoice_items → receiving_invoices → receiving_orders`), not from `parts.supplier_id` |
| GET | `/stock-search/suppliers/:id/parts` | `200 [{ id, part_no, description }]`; `404` supplier not found |
| GET | `/stock-search/parts/lots` | Query `part_ids` (comma-separated, required) → `200 [{ part_id, date_code, lot_code, coo, cow, shelf_code, box_id, total_qty, allocated_qty, available_qty, location_label }]`; `400` missing param. `location_label` is `shelf / box`, `shelf`, `box`, or `receiving-area` |

## Suppliers

| Method | Path | Response |
|--------|------|----------|
| GET | `/suppliers/qr-templates` | `200 [{ code, qr_template, qrcode_qty_encoding }]` — only suppliers with a `qr_template`, ordered by code |

## Route map (source files)

| Domain | File |
|--------|------|
| health, auth, dev | `src/routes/health.ts`, `auth.ts`, `dev.ts` |
| receiving (orders, scan candidates, ingest, confirm) | `src/routes/receiving.ts` |
| picking (list/detail, ingest, issue reports, ocr-pick) | `src/routes/picking.ts` |
| picking execution (scan/box mutations) | `src/routes/pickingExecution.ts` |
| put-away | `src/routes/putAway.ts` |
| measuring + shipping boxes | `src/routes/measuring.ts`, `boxes.ts` |
| verification tasks | `src/routes/verification.ts` |
| goods verify (shelves/shelf boxes) | `src/routes/goodsVerify.ts` |
| mismatches | `src/routes/mismatch.ts` |
| stock search, suppliers | `src/routes/stockSearch.ts`, `suppliers.ts` |
