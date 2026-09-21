# Receiving order name display template — design (2026-09-21)

Configurable per-warehouse policy for how a receiving order's **name** renders in the
PDA app and the admin console. Today every surface shows the raw `batch_no`
(`apps/web/pages/receiving/index.vue` list title, `apps/web/pages/receiving/[id].vue`
header, `apps/admin/pages/receiving/index.vue` batch-no column, `apps/admin/pages/receiving/[id].vue`
h1). Warehouse staff think of an order by "batch no + invoice no" (or supplier, or
delivery date), so the join becomes a config — same mechanism as
`dateCodeDisplayTemplate` (spec 2026-09-17-date-code-display-template-design.md).

## Config

New top-level key in the `warehouse_config` row `"flow"`:

```json
{ "receivingOrderNameTemplate": "[batch_no]" }
```

- `receivingOrderNameTemplate` — non-empty string. Default `"[batch_no]"` (= today's
  behavior).
- Placeholders:
  - `[batch_no]` — `receiving_orders.batch_no`
  - `[invoice_no]` — the order's invoice numbers, comma-joined (`"INV-1, INV-2"`;
    same aggregation the list endpoint already returns as `invoiceNos`). Empty when
    the order has no invoices.
  - `[invoice_no_first]` — only the first invoice number (short form for orders
    with many invoices). Empty when the order has no invoices.
  - `[supplier_code]` — `receiving_orders.supplier_code`
  - `[supplier_name]` — joined `suppliers.name`
  - `[delivery_date]` — `delivery_date` rendered `YYYY-MM-DD`
  - `[date_code]` — `receiving_orders.date_code`
- A placeholder whose field is null/empty renders as `""` → no dangling separators.
- Text outside brackets is literal; unknown `[tokens]` are left as-is.
- If the whole template renders empty (e.g. `"[invoice_no]"` on an order without
  invoices), the formatter falls back to `batch_no` so a row never shows blank.
- `mergeFlowConfigJson` rejects non-string / blank values with
  `[config] flow config.receivingOrderNameTemplate must be a non-empty string`
  (→ PUT `/admin/flow-config` returns 400).

## Application: backend-computed `displayName`

Unlike the date-code template (admin-only, applied client-side), this template is
**applied in the backend** so one implementation serves both audiences:

- `GET /receiving-orders` — each row gains `displayName`.
- `GET /receiving-orders/:id` — the detail gains `displayName`.

Implementation: `apps/backend/src/receivingOrderName.ts`
(`formatReceivingOrderName`) + the `receivingOrderNameTemplate()` config accessor.
The list reuses its existing `invoiceNos` aggregation; the detail joins its loaded
`invoices[].invoiceNo`. Because the name is computed per request from the in-memory
flow config, a runtime `PUT /admin/flow-config` takes effect immediately — no
restart, no PDA refetch of config.

Clients render `displayName ?? batchNo` (fallback keeps older backends working).

## Render sites

- `apps/web/pages/receiving/index.vue` — list-row title.
- `apps/web/pages/receiving/[id].vue` — `DetailHeader` title.
- `apps/admin/pages/receiving/index.vue` — the batch-no column renders `displayName`
  (search/sort keep using the raw fields).
- `apps/admin/pages/receiving/[id].vue` — the page h1. Confirm dialogs / xlsx
  filenames keep the raw `batchNo`.

Admin editing: `apps/admin/pages/display-config.vue` gains a second card for the
receiving-order name template — placeholder chips, a live preview (full sample
order + a missing-fields sample showing the batch-no fallback), saving both
template keys merged over the stored JSON via `PUT /admin/flow-config`.

## Out of scope (later phases)

- Other receiving-order name surfaces (put-away candidate lists, label/carton pages,
  picking "receiving" tooltips, goods-verify) keep showing `batch_no`.
- PDA list-view field selection (which fields show on PDA list rows) — the follow-up
  feature the user described as part 2.
- No change to storage or sync.
