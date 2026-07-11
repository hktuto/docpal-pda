export const createTablesSql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, qr_template TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY, part_no TEXT NOT NULL, part_no_norm TEXT NOT NULL, description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS parts_part_no_norm_idx ON parts(part_no_norm);
CREATE TABLE IF NOT EXISTS shelves (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS receiving_orders (
  id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, ref_no TEXT NOT NULL, delivery_date TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','in_hand','clear')), supplier_id TEXT REFERENCES suppliers(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS receiving_orders_status_updated_idx ON receiving_orders(status, updated_at);
CREATE INDEX IF NOT EXISTS receiving_orders_supplier_idx ON receiving_orders(supplier_id);
CREATE TABLE IF NOT EXISTS receiving_invoices (
  id TEXT PRIMARY KEY, external_id TEXT, receiving_order_id TEXT NOT NULL REFERENCES receiving_orders(id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL, supplier_id TEXT REFERENCES suppliers(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(receiving_order_id, invoice_no));
CREATE INDEX IF NOT EXISTS receiving_invoices_order_idx ON receiving_invoices(receiving_order_id);
CREATE INDEX IF NOT EXISTS receiving_invoices_supplier_idx ON receiving_invoices(supplier_id);
CREATE TABLE IF NOT EXISTS receiving_invoice_items (
  id TEXT PRIMARY KEY, receiving_invoice_id TEXT NOT NULL REFERENCES receiving_invoices(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id), qty INTEGER NOT NULL DEFAULT 0, received_qty INTEGER NOT NULL DEFAULT 0,
  picked_qty INTEGER NOT NULL DEFAULT 0, put_away_qty INTEGER NOT NULL DEFAULT 0,
  allocated_qty INTEGER NOT NULL DEFAULT 0, available_qty INTEGER NOT NULL DEFAULT 0, box_id TEXT,
  date_code TEXT, lot_code TEXT, coo TEXT, cow TEXT, date_code_norm TEXT, lot_code_norm TEXT, coo_norm TEXT, cow_norm TEXT, line_no INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rii_part_available_idx ON receiving_invoice_items(part_id, available_qty);
CREATE INDEX IF NOT EXISTS rii_invoice_idx ON receiving_invoice_items(receiving_invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS rii_invoice_line_uq ON receiving_invoice_items(receiving_invoice_id, line_no) WHERE line_no IS NOT NULL;
CREATE TABLE IF NOT EXISTS receiving_item_mismatches (
  id TEXT PRIMARY KEY, receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rim_item_idx ON receiving_item_mismatches(receiving_invoice_item_id);

CREATE TABLE IF NOT EXISTS picking_orders (
  id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, ref_no TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','picking','finished','issue')), ship_to TEXT, destination_country TEXT,
  issue_reason TEXT, issue_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS picking_orders_status_updated_idx ON picking_orders(status, updated_at);
CREATE TABLE IF NOT EXISTS picking_items (
  id TEXT PRIMARY KEY, picking_order_id TEXT NOT NULL REFERENCES picking_orders(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id), qty INTEGER NOT NULL DEFAULT 0, picked_qty INTEGER NOT NULL DEFAULT 0,
  allocated_qty INTEGER NOT NULL DEFAULT 0, required_date_code TEXT, source_shelf_code TEXT,
  scanned_not_boxed_qty INTEGER NOT NULL DEFAULT 0,
  remaining_qty INTEGER GENERATED ALWAYS AS (qty - picked_qty - scanned_not_boxed_qty) STORED,
  line_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS picking_items_part_idx ON picking_items(part_id);
CREATE INDEX IF NOT EXISTS picking_items_order_idx ON picking_items(picking_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS picking_items_order_line_uq ON picking_items(picking_order_id, line_id) WHERE line_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS shipping_boxes (
  id TEXT PRIMARY KEY, picking_order_id TEXT NOT NULL REFERENCES picking_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','verified')), box_size TEXT,
  net_weight_g INTEGER, gross_weight_g INTEGER, destination_country TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shipping_boxes_order_idx ON shipping_boxes(picking_order_id);
CREATE INDEX IF NOT EXISTS shipping_boxes_status_idx ON shipping_boxes(status);
CREATE TABLE IF NOT EXISTS picking_packages (
  id TEXT PRIMARY KEY, picking_item_id TEXT NOT NULL REFERENCES picking_items(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN ('receiving_invoice_item','inventory_lot')), source_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0, shipping_box_id TEXT REFERENCES shipping_boxes(id),
  date_code TEXT, lot_code TEXT, coo TEXT, cow TEXT, verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS picking_packages_box_idx ON picking_packages(shipping_box_id);
CREATE INDEX IF NOT EXISTS picking_packages_item_idx ON picking_packages(picking_item_id);

CREATE TABLE IF NOT EXISTS inventory_lots (
  id TEXT PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts(id),
  date_code TEXT, lot_code TEXT, coo TEXT, cow TEXT, date_code_norm TEXT, lot_code_norm TEXT, coo_norm TEXT, cow_norm TEXT,
  shelf_code TEXT, box_id TEXT, total_qty INTEGER NOT NULL DEFAULT 0, allocated_qty INTEGER NOT NULL DEFAULT 0,
  available_qty INTEGER GENERATED ALWAYS AS (total_qty - allocated_qty) STORED,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS inventory_lots_part_shelf_avail_idx ON inventory_lots(part_id, shelf_code, available_qty);
CREATE TABLE IF NOT EXISTS inventory_lot_sources (
  id TEXT PRIMARY KEY, inventory_lot_id TEXT NOT NULL REFERENCES inventory_lots(id) ON DELETE CASCADE,
  receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id), qty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ils_lot_idx ON inventory_lot_sources(inventory_lot_id);
CREATE INDEX IF NOT EXISTS ils_item_idx ON inventory_lot_sources(receiving_invoice_item_id);
CREATE TABLE IF NOT EXISTS shelf_boxes (
  id TEXT PRIMARY KEY, shelf_code TEXT NOT NULL, box_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shelf_boxes_shelf_idx ON shelf_boxes(shelf_code);
CREATE TABLE IF NOT EXISTS shelf_box_items (
  id TEXT PRIMARY KEY, shelf_box_id TEXT NOT NULL REFERENCES shelf_boxes(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id), qty INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shelf_box_items_box_idx ON shelf_box_items(shelf_box_id);
CREATE INDEX IF NOT EXISTS shelf_box_items_part_idx ON shelf_box_items(part_id);
CREATE TABLE IF NOT EXISTS put_away_scans (
  id TEXT PRIMARY KEY, receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id),
  qty INTEGER NOT NULL DEFAULT 0, shelf_box_id TEXT REFERENCES shelf_boxes(id), verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT, date_code TEXT, lot_code TEXT, coo TEXT, cow TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS put_away_scans_item_idx ON put_away_scans(receiving_invoice_item_id);
CREATE INDEX IF NOT EXISTS put_away_scans_box_idx ON put_away_scans(shelf_box_id);

CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY, picking_item_id TEXT NOT NULL REFERENCES picking_items(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL DEFAULT 0, remark TEXT, inventory_lot_id TEXT REFERENCES inventory_lots(id),
  receiving_order_id TEXT REFERENCES receiving_orders(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((inventory_lot_id IS NOT NULL) != (receiving_order_id IS NOT NULL)));
CREATE INDEX IF NOT EXISTS allocations_item_idx ON allocations(picking_item_id);
CREATE INDEX IF NOT EXISTS allocations_lot_idx ON allocations(inventory_lot_id);
CREATE INDEX IF NOT EXISTS allocations_receiving_order_idx ON allocations(receiving_order_id);
CREATE TABLE IF NOT EXISTS allocation_receiving_items (
  id TEXT PRIMARY KEY, allocation_id TEXT NOT NULL REFERENCES allocations(id) ON DELETE CASCADE,
  receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id), qty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(allocation_id, receiving_invoice_item_id));
CREATE INDEX IF NOT EXISTS ari_item_idx ON allocation_receiving_items(receiving_invoice_item_id);
CREATE INDEX IF NOT EXISTS ari_allocation_idx ON allocation_receiving_items(allocation_id);

CREATE TABLE IF NOT EXISTS measuring_tasks (
  id TEXT PRIMARY KEY, picking_order_id TEXT NOT NULL UNIQUE REFERENCES picking_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS measuring_tasks_status_updated_idx ON measuring_tasks(status, updated_at);
CREATE TABLE IF NOT EXISTS verification_tasks (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('pre_shipment','cycle_count')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')), due_at TEXT,
  picking_order_id TEXT REFERENCES picking_orders(id) ON DELETE CASCADE,
  shelf_box_id TEXT REFERENCES shelf_boxes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((kind = 'pre_shipment') = (picking_order_id IS NOT NULL)),
  CHECK ((kind = 'cycle_count') = (shelf_box_id IS NOT NULL)));
CREATE INDEX IF NOT EXISTS verification_tasks_kind_status_updated_idx ON verification_tasks(kind, status, updated_at);
CREATE INDEX IF NOT EXISTS verification_tasks_picking_order_idx ON verification_tasks(picking_order_id);
CREATE INDEX IF NOT EXISTS verification_tasks_shelf_box_idx ON verification_tasks(shelf_box_id);
CREATE UNIQUE INDEX IF NOT EXISTS verification_tasks_cycle_coalesce_uq ON verification_tasks(kind, shelf_box_id, date(due_at));

CREATE TABLE IF NOT EXISTS transition_logs (
  id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, from_status TEXT, to_status TEXT,
  actor_id TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS transition_logs_entity_idx ON transition_logs(entity_type, entity_id);
`;

import type { Database as DatabaseType } from "better-sqlite3";

// The API keeps a persistent dev.sqlite across launches (no migrations).
// createTables runs on every boot and must be idempotent for BOTH a fresh DB
// and a pre-existing DB that predates newly added columns. The partial unique
// indexes below reference line_no / line_id, so a stale DB must gain those
// columns before the DDL script executes (else "no such column").
function ensureColumn(sqlite: DatabaseType, table: string, column: string, decl: string): void {
  const exists = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (!exists) return; // fresh DB: CREATE TABLE below already declares the column
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
}

export function createTables(sqlite: DatabaseType): void {
  ensureColumn(sqlite, "receiving_invoice_items", "line_no", "line_no INTEGER");
  ensureColumn(sqlite, "picking_items", "line_id", "line_id TEXT");
  sqlite.exec(createTablesSql);
}
