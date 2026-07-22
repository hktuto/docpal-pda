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

## Amendment 2026-07-22 — sub-inventory restored next to org_id

The 2026-07-21 redesign collapsed warehouse_code / warehouse_section_code /
sub_inventory_code down to org_id. This amendment restores
`sub_inventory_code` (only — warehouse_code and warehouse_sections stay gone):
the pair **`org_id` + `sub_inventory_code`** now identifies stock partitioning
(Oracle EBS organization + subinventory style).

- **`sub_inventories` is back** (`code` PK, `name`, `org_id` integer NOT NULL,
  `customer_code` nullable FK → customer_profiles, timestamps).
  `sub_inventories.org_id` anchors which org the sub-inventory belongs to —
  the pair is enforced here (plain integer office id, no FK to a lookup).
- **`sub_inventory_code`** (FK → sub_inventories(code)) sits next to the
  existing `org_id` on `shelves` (nullable), `receiving_orders` (NOT NULL —
  mandatory like the pre-redesign design), `receiving_invoices` (nullable),
  `receiving_invoice_items` (nullable). `picking_orders` gains both `org_id`
  and `sub_inventory_code` **nullable**; `inventory_lots` gains both
  **nullable**, and the `inventory_lots_unique_lot` partial unique index is
  extended with the pair.
- **Allocation matches on the pair again** (adapted from the pre-redesign
  engine): demands carry the pair from picking_orders; lots match on their own
  pair, receiving sources on the receiving order's pair; a demand without the
  pair is org-agnostic and matches anything. Customer segregation returns via
  `sub_inventories.customer_code` — sources in a customer-segregated
  sub-inventory only allocate to picking orders of that customer
  (`customer_profiles.rule` remains stored-not-interpreted).
- Put-away lot materialization stamps the lot's pair from the shelf; the
  receiving ingest upsert requires `order.subInventoryCode` again (400 when
  missing) and the picking upsert accepts the pair optionally.
