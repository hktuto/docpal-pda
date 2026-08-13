# Ingest API (DocPal → Warehouse server-to-server sync)

Base URL: `http://<backend-host>:3002` (prod stack: `:9002`). All endpoints require a JWT
bearer token (`POST /auth/login` → `{user, token}`).

All endpoints are **idempotent upserts keyed by natural keys** (never by UUID), plus matching
DELETEs. Bodies and responses are camelCase JSON. Derived state (received/picked/put-away/
allocated quantities, mismatch flags) is never writable — the warehouse computes it.

## Conventions

- **Upsert response** — `201` on create, `200` on update:
  ```json
  { "id": "018f4c2a-…", "created": true, "changed": true }
  ```
  `changed: false` means the payload was identical to what is stored (no writes happened).
- **Delete response** — `200`:
  ```json
  { "id": "018f4c2a-…", "deleted": true }
  ```
- **Caller-supplied `id` (optional, every create):** pass your own UUID as `"id"` at the
  order/invoice/item/master level and it becomes the row's primary key on **create only**.
  On update (same natural key), a supplied `id` is ignored — reconciliation stays keyed by
  the natural keys. `400 invalid_id` for a malformed id, `409 id_already_exists` if the id
  belongs to a different row.
- **Errors** — `{ "message": "<snake_code>" }` with a 4xx status; codes listed per endpoint.
- Every write is recorded in the `sync_events` feed (`GET /sync-events?since=`) for the
  external sync service.

---

## Receiving orders

### `PUT /receiving-orders/:batchNo`

Upserts a packing-list batch with its invoices and invoice items.

- Reconcile keys: order by `batch_no` (path), invoices by `invoice_no`, items by
  `part_no + po_no + po_line`.
- Invoices/items **missing from the payload are deleted** (guarded, see errors).
- `order.subInventoryCode` is required — every receiving order lands in exactly one
  sub-inventory.
- `supplierCode` (order or invoice level) must exist in `suppliers`; `partNo` must exist in
  `parts`.

Request:

```http
PUT /receiving-orders/BATCH-2026-0813-01 HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "order": {
    "id": "018f4c2a-7b1d-7f3e-9a2c-1d4e5f6a7b8c",
    "supplierCode": "S1001",
    "deliveryDate": "2026-08-20",
    "dateCode": "25+26",
    "orgId": 2,
    "subInventoryCode": "STORE1"
  },
  "invoices": [
    {
      "id": "018f4c2a-8c2e-7f3e-9a2c-1d4e5f6a7b8d",
      "invoiceNo": "INV-881",
      "supplierCode": "S1001",
      "wclCompanyName": "ACME HK LTD",
      "totalQty": 5000,
      "totalCtn": 10,
      "deliveryDate": "2026-08-18",
      "orgId": 2,
      "subInventoryCode": "STORE1",
      "items": [
        {
          "id": "018f4c2a-9d3f-7f3e-9a2c-1d4e5f6a7b8e",
          "partNo": "ABC/1234-XYZ",
          "wclItemNo": "W-7788",
          "poNo": "PO-4500",
          "poLine": "10",
          "lineQty": 3000,
          "ctnNo": "CTN-01",
          "dateCode": "2526",
          "lotCode": "L-991",
          "coo": "JP",
          "cow": "JP",
          "orgId": 2,
          "subInventoryCode": "STORE1",
          "additionalData": { "uom": "PCS" }
        },
        { "partNo": "DEF/5678-ABC", "poNo": "PO-4500", "poLine": "20", "lineQty": 2000 }
      ]
    }
  ]
}
```

Only `order.subInventoryCode`, `invoices[].invoiceNo`, `items[].partNo` and
`items[].lineQty` are required; everything else is optional/nullable. `orgId` defaults to
`2` (HK). `additionalData` is an arbitrary JSON passthrough.

Responses:

```json
// 201 — first push of this batch_no
{ "id": "018f4c2a-7b1d-7f3e-9a2c-1d4e5f6a7b8c", "created": true, "changed": true }

// 200 — re-push with changes (or "changed": false when identical)
{ "id": "018f4c2a-7b1d-7f3e-9a2c-1d4e5f6a7b8c", "created": false, "changed": true }
```

Errors: `400` `invalid JSON body` / `order is required` / `order.subInventoryCode is required` /
`invoices[] is required` / `invoiceNo is required` / `partNo is required` /
`lineQty must be a non-negative integer` / `invalid_delivery_date` / `unknown_supplier: <code>` /
`unknown_part: <partNo>` / `invalid_id` —
`409` `id_already_exists` / `qty_may_only_increase_once_<status>` /
`cannot_decrease_qty_after_work_started` / `cannot_remove_line_once_<status>` /
`cannot_remove_line_after_work_started` / `cannot_remove_invoice_once_<status>` /
`cannot_remove_invoice_after_work_started`.

Side effect: a changed upsert on an order past `pending` triggers a best-effort
re-allocation of open picking demands.

### `DELETE /receiving-orders/:batchNo`

Deletes the order and (cascade) its invoices, items, scan labels, allocations and put-away
task. Only allowed while nothing has been acted on.

```http
DELETE /receiving-orders/BATCH-2026-0813-01 HTTP/1.1
Authorization: Bearer <token>
```

```json
// 200
{ "id": "018f4c2a-7b1d-7f3e-9a2c-1d4e5f6a7b8c", "deleted": true }

// 404
{ "message": "not_found" }

// 409 — order already processed
{ "message": "cannot_delete_once_in_hand" }

// 409 — some line already has scans / allocations
{ "message": "cannot_delete_after_work_started" }
```

---

## Picking orders

### `PUT /picking-orders/:orderNo`

Upserts a picking order and its items.

- Reconcile keys: order by `order_no` (path), items by `part_no`.
- Items **missing from the payload are deleted** (guarded).
- `customerCode` must exist in `customer_profiles`; `partNo` must exist in `parts`.
- On create the order is slotted into the priority queue by (delivery date, order_no).

Request:

```http
PUT /picking-orders/TN-2026-00912 HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "order": {
    "id": "018f4d11-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
    "poNo": "PO-CUST-77",
    "shipTo": "ACME SHENZHEN, CN",
    "customerCode": "C1001",
    "deliveryDate": "2026-08-25",
    "orgId": 2,
    "subInventoryCode": "STORE1"
  },
  "items": [
    {
      "id": "018f4d11-2b3c-7c3d-8e4f-5a6b7c8d9e10",
      "partNo": "ABC/1234-XYZ",
      "qty": 500,
      "lineId": 1002341,
      "lineNumber": 1,
      "shipmentNumber": 1,
      "additionalData": { "uom": "PCS" }
    },
    {
      "partNo": "DEF/5678-ABC",
      "qty": 250,
      "lineId": 1002342,
      "lineNumber": 2,
      "shipmentNumber": 1
    }
  ]
}
```

Required per item: `partNo`, `qty`, `lineId`, `lineNumber`, `shipmentNumber`
(the Oracle line identifiers — integers). All order fields are optional.

Responses:

```json
// 201
{ "id": "018f4d11-1a2b-7c3d-8e4f-5a6b7c8d9e0f", "created": true, "changed": true }

// 200
{ "id": "018f4d11-1a2b-7c3d-8e4f-5a6b7c8d9e0f", "created": false, "changed": false }
```

Errors: `400` `order is required` / `items[] is required` / `partNo is required` /
`qty must be a non-negative integer` / `lineId must be an integer` /
`unknown_customer: <code>` / `unknown_part: <partNo>` / `invalid_delivery_date` / `invalid_id` —
`409` `id_already_exists` / `qty_below_picked: <qty> < <picked>` /
`cannot_remove_line_after_work_started`.

Side effect: a changed upsert on an open (`pending`/`picking`) order triggers a best-effort
re-allocation.

### `DELETE /picking-orders/:orderNo`

Deletes the order; items, packages and allocations cascade. Only allowed while the order is
`pending` and nothing has been picked or allocated. `priority_seq` of remaining orders is
not compacted (gaps are harmless).

```http
DELETE /picking-orders/TN-2026-00912 HTTP/1.1
Authorization: Bearer <token>
```

```json
// 200
{ "id": "018f4d11-1a2b-7c3d-8e4f-5a6b7c8d9e0f", "deleted": true }

// 404
{ "message": "not_found" }

// 409
{ "message": "cannot_delete_once_picking" }
{ "message": "cannot_delete_after_work_started" }
```

---

## Parts (master data)

### `PUT /parts/:partNo`

Upsert keyed by `part_no`. All other warehouse tables reference parts by `part_no`, so the
UUID `id` is internal-only.

```http
PUT /parts/ABC%2F1234-XYZ HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "id": "018f4e00-aa01-7000-8000-000000000001",
  "brand": "S1001",
  "wclItemNo": "W-7788",
  "description": "IC MCU 32BIT 256KB FLASH",
  "defaultCoo": "JP"
}
```

`brand` is required (the supplier business code, plain text — no FK). URL-encode `/` in the
path (`%2F`).

```json
// 201 / 200
{ "id": "018f4e00-aa01-7000-8000-000000000001", "created": true, "changed": true }
```

### `DELETE /parts/:partNo`

```json
// 200
{ "id": "018f4e00-aa01-7000-8000-000000000001", "deleted": true }

// 404 — { "message": "not_found" }
// 409 — part is referenced by orders/stock: { "message": "cannot_delete_referenced" }
```

Errors on PUT: `400` `brand is required` / `invalid_id` — `409` `id_already_exists`.

---

## Suppliers (master data)

### `PUT /suppliers/:code`

Upsert keyed by supplier `code`. `suppliers` stays a pure AP_SUPPLIERS mirror — PDA-local
fields belong in `supplier_profiles` (below).

```http
PUT /suppliers/S1001 HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "id": "018f4e00-bb02-7000-8000-000000000002",
  "name": "ACME COMPONENTS LTD",
  "shortName": "ACME"
}
```

`name` is required.

```json
// 201 / 200
{ "id": "018f4e00-bb02-7000-8000-000000000002", "created": true, "changed": true }
```

### `DELETE /suppliers/:code`

```json
// 200
{ "id": "018f4e00-bb02-7000-8000-000000000002", "deleted": true }

// 404 — { "message": "not_found" }
// 409 — referenced by orders/profile: { "message": "cannot_delete_referenced" }
```

Errors on PUT: `400` `name is required` / `invalid_id` — `409` `id_already_exists`.

---

## Supplier profiles (master data)

### `PUT /supplier-profiles/:supplierCode`

Upsert keyed by `supplier_code` — one profile per supplier. The supplier row must already
exist (`400 unknown_supplier`).

```http
PUT /supplier-profiles/S1001 HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "id": "018f4e00-cc03-7000-8000-000000000003",
  "name": "ACME (local display)",
  "qrTemplate": "^(?<partNo>[^|]+)\\|(?<qty>\\d+)$",
  "qrTemplateConfig": {
    "version": 1,
    "mode": "delimited",
    "delimiter": "|",
    "fields": [
      { "key": "partNo", "label": "Part No" },
      { "key": "qty", "label": "Qty" }
    ]
  },
  "qrType": "ban 14",
  "qtyEncoding": "koa_zeros",
  "remark": " carton label only"
}
```

All fields optional; `qrTemplateConfig` is an arbitrary JSON blob produced by the admin QR
template editor (null for legacy hand-written regex templates).

```json
// 201 / 200
{ "id": "018f4e00-cc03-7000-8000-000000000003", "created": true, "changed": true }
```

### `DELETE /supplier-profiles/:supplierCode`

```json
// 200
{ "id": "018f4e00-cc03-7000-8000-000000000003", "deleted": true }

// 404 — { "message": "not_found" }
```

Errors on PUT: `400` `unknown_supplier: <code>` / `invalid_id` — `409` `id_already_exists`.

---

## Sub-inventories (master data)

The warehouse mirrors the DocPal/Oracle sub-inventory table. Upsert key is the pair
`(orgId, code)` in the path — `code` maps to the `secondary_inventory_name` column
(e.g. `STORE1`), `orgId` to `org_id` (`2` = HK).

### `PUT /sub-inventories/:orgId/:code`

```http
PUT /sub-inventories/2/STORE1 HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "id": "018f4e00-dd04-7000-8000-000000000004",
  "subinvDescription": "Main store HK",
  "officeCode": "HK",
  "organizationId": 101,
  "customerCode": null
}
```

Field mapping to the upstream table:

| Body field | Column | Notes |
|---|---|---|
| *(path)* `:orgId` | `org_id` | integer, 2 = HK (`400 invalid_org_id` if not an integer) |
| *(path)* `:code` | `secondary_inventory_name` | the Oracle subinventory name |
| `subinvDescription` | `subinv_description` | |
| `officeCode` | `office_code` | |
| `organizationId` | `organization_id` | Oracle inventory-organization id (NUMBER → integer) |
| `customerCode` | `customer_code` | warehouse-local: set for customer-segregated stores; must exist in `customer_profiles` (`400 unknown_customer`) |

```json
// 201 / 200
{ "id": "018f4e00-dd04-7000-8000-000000000004", "created": true, "changed": true }
```

### `DELETE /sub-inventories/:orgId/:code`

```json
// 200
{ "id": "018f4e00-dd04-7000-8000-000000000004", "deleted": true }

// 404 — { "message": "not_found" }
// 409 — stock/orders reference this store: { "message": "cannot_delete_referenced" }
```

Errors on PUT: `400` `invalid_org_id` / `unknown_customer: <code>` / `invalid_id` —
`409` `id_already_exists`.

---

## Error code summary

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid JSON body` | body is not valid JSON |
| 400 | `invalid_id` | supplied `id` is not a UUID |
| 400 | `invalid_delivery_date` | unparseable date |
| 400 | `invalid_org_id` | sub-inventory path orgId not an integer |
| 400 | `unknown_supplier` / `unknown_part` / `unknown_customer` | referenced master row missing |
| 400 | `<field> is required` / `must be a non-negative integer` / `must be an integer` | validation |
| 404 | `not_found` | DELETE on an unknown natural key |
| 409 | `id_already_exists` | supplied `id` belongs to a different row |
| 409 | `cannot_delete_referenced` | master row is FK-referenced by orders/stock |
| 409 | `cannot_delete_once_<status>` | order no longer `pending` |
| 409 | `cannot_delete_after_work_started` | order has scans/allocations/picked qty |
| 409 | `qty_may_only_increase_once_<status>` / `cannot_decrease_qty_after_work_started` | receiving qty-decrease guards |
| 409 | `cannot_remove_line_*` / `cannot_remove_invoice_*` | reconcile removal guards |
| 409 | `qty_below_picked: <qty> < <picked>` | picking qty below already-picked |

Design specs: `docs/superpowers/specs/2026-08-13-ingest-caller-ids-and-delete-design.md`,
`docs/superpowers/specs/2026-08-13-subinventory-rename-and-masterdata-ingest-design.md`.
Implementation: `apps/backend/src/routes/ingest.ts` + `apps/backend/src/db/ingest.ts`.
