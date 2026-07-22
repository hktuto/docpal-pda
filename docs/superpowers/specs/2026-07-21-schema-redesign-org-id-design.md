# Schema redesign: org_id, natural keys, part_no references — design

Status: approved 2026-07-21. Target contract: `docs/backend/schema-tables.md`
(that file is the authoritative table-by-table spec; this doc records the
decisions behind it).

## Decisions

1. **Standalone warehouse instance** — `warehouse_code` removed everywhere;
   `WAREHOUSE_CODE` env / `defaultWarehouse()` go away.
2. **`org_id` (integer, office: 2=HK, …)** replaces `warehouse_section_code` +
   `sub_inventory_code`. Lookup tables `warehouse_sections` and
   `sub_inventories` are dropped. `org_id` lives on `shelves` (nullable),
   `receiving_orders` / `receiving_invoices` / `receiving_invoice_items`
   (NOT NULL DEFAULT 2) — each invoice inside a receiving order can be in a
   different org. `picking_orders` deliberately has **no** `org_id`;
   allocation is org-agnostic. A lot's org derives via
   `shelf_code → shelves.org_id`.
3. **No `external_id`.** Receiving orders/invoices/items are created locally
   by users. Picking orders are a replica of an upstream DB keyed by
   `order_no` (UNIQUE — the sync/dedup key). Ingest upsert routes key on the
   natural keys: `PUT /receiving-orders/:batchNo`,
   `PUT /picking-orders/:orderNo`.
4. **Parts referenced by `part_no`**, not UUID. `parts` stays in our DB
   (upstream may not provide one); `parts.id` remains as internal PK,
   `parts.part_no` is UNIQUE and the FK target for
   `receiving_invoice_items`, `picking_items`, `inventory_lots`,
   `shipping_box_items`, `shelf_box_items`, `goods_verify_tasks`,
   `net_weight_formula`, `inventory_transactions`.
   (Doc erratum: `parts.supplier_code` is NOT UNIQUE — one supplier has many
   parts.)
5. **Renames:** `receiving_orders.ref_no → batch_no`;
   `picking_orders.ref_no → order_no`; `receiving_invoice_items.qty →
   line_qty` (Oracle parity); `receiving_invoice_items.box_id → ctn_no`;
   `picking_orders.destination_country` merged into `ship_to`;
   `picking_items` drops `required_date_code` / `source_shelf_code`;
   `picking_orders` drops `required_date_code_notice`.
6. **Additions:** `customer_profiles.rule` (text — customer custom
   requirement/formula; stored, not yet interpreted by the allocation engine —
   the old sub-inventory-based customer segregation is removed),
   `supplier_profiles.qr_type`, `parts.supplier_code`.
7. **Box ids** lose the warehouse segment: `BOX-S-<YYYYMMDD>-<seq>`,
   `BOX-H-<YYYYMMDD>-<seq>`.
8. **Kept but internal/demo:** `users` (demo login, external user system
   later), `app_events` (SSE outbox), `receiving_scan_labels` (scan dedup).
9. `inventory_lots_unique_lot` becomes partial unique on `(part_no, date_code,
   coo, cow, shelf_code, box_id)` WHERE `shelf_code IS NOT NULL OR box_id IS
   NOT NULL`.

## Implementation notes

- One new Drizzle migration (`db:generate` → 0014); never hand-edit 0000–0013.
- The working tree is mid-refactor (schema columns commented out while
  seed/domain code still references them) — this change completes it.
- SSE event payloads rename `externalId` → `batchNo` / `orderNo`; web i18n
  toast placeholders change in the same release.
- Client impact inventory: `apps/web/services/types.ts` is the DTO contract
  (no `packages/shared` usage in web); admin drops the sub-inventories and
  warehouse-sections CRUD pages.
