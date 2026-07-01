// Raw SQL used to bootstrap the PostgreSQL schema inside PGlite.
// Drizzle's pglite driver does not run migrations automatically, so we execute these once on first load.

export const createTablesSql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY,
  part_no TEXT NOT NULL UNIQUE,
  internal_code TEXT,
  description TEXT,
  default_origin_country TEXT
);

CREATE TABLE IF NOT EXISTS shelves (
  code TEXT PRIMARY KEY,
  zone TEXT
);

CREATE TABLE IF NOT EXISTS receiving_orders (
  id TEXT PRIMARY KEY,
  ref_no TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  delivery_date TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',
  arrived_at TIMESTAMP,
  arrived_by TEXT REFERENCES users(id),
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receiving_orders_status ON receiving_orders(status);

CREATE TABLE IF NOT EXISTS receiving_invoices (
  id TEXT PRIMARY KEY,
  receiving_order_id TEXT NOT NULL REFERENCES receiving_orders(id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS receiving_invoice_items (
  id TEXT PRIMARY KEY,
  receiving_invoice_id TEXT NOT NULL REFERENCES receiving_invoices(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id),
  po_no TEXT,
  po_line TEXT,
  qty INTEGER NOT NULL,
  received_qty INTEGER NOT NULL DEFAULT 0,
  picked_qty INTEGER NOT NULL DEFAULT 0,
  put_away_qty INTEGER NOT NULL DEFAULT 0,
  box_id TEXT,
  date_code TEXT,
  lot_code TEXT,
  origin_country TEXT,
  reported_mismatch BOOLEAN DEFAULT FALSE,
  mismatch_note TEXT
);

CREATE TABLE IF NOT EXISTS picking_orders (
  id TEXT PRIMARY KEY,
  ref_no TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  delivery_date TIMESTAMP,
  po_no TEXT,
  required_date_code_notice TEXT,
  ship_to TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_picking_orders_status ON picking_orders(status);

CREATE TABLE IF NOT EXISTS picking_items (
  id TEXT PRIMARY KEY,
  picking_order_id TEXT NOT NULL REFERENCES picking_orders(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id),
  qty INTEGER NOT NULL,
  picked_qty INTEGER NOT NULL DEFAULT 0,
  allocated_qty INTEGER NOT NULL DEFAULT 0,
  required_date_code TEXT,
  source_shelf_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_picking_items_order ON picking_items(picking_order_id);

CREATE TABLE IF NOT EXISTS inventory_lots (
  id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL REFERENCES parts(id),
  date_code TEXT,
  lot_code TEXT,
  origin_country TEXT,
  shelf_code TEXT REFERENCES shelves(code),
  box_id TEXT,
  total_qty INTEGER NOT NULL DEFAULT 0,
  allocated_qty INTEGER NOT NULL DEFAULT 0,
  available_qty INTEGER NOT NULL GENERATED ALWAYS AS (total_qty - allocated_qty) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_lots_unique_lot
  ON inventory_lots(part_id, date_code, lot_code, origin_country, shelf_code, box_id)
  WHERE shelf_code IS NOT NULL OR box_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_lots_part ON inventory_lots(part_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_available ON inventory_lots(part_id, available_qty);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_location ON inventory_lots(shelf_code, box_id);

CREATE TABLE IF NOT EXISTS inventory_lot_sources (
  id TEXT PRIMARY KEY,
  inventory_lot_id TEXT NOT NULL REFERENCES inventory_lots(id) ON DELETE CASCADE,
  receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_lot_sources_unique
  ON inventory_lot_sources(inventory_lot_id, receiving_invoice_item_id);

CREATE INDEX IF NOT EXISTS idx_inventory_lot_sources_receiving_item ON inventory_lot_sources(receiving_invoice_item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lot_sources_lot ON inventory_lot_sources(inventory_lot_id);

CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  picking_item_id TEXT NOT NULL REFERENCES picking_items(id) ON DELETE CASCADE,
  inventory_lot_id TEXT REFERENCES inventory_lots(id) ON DELETE CASCADE,
  receiving_invoice_item_id TEXT REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_allocations_picking_item ON allocations(picking_item_id);
CREATE INDEX IF NOT EXISTS idx_allocations_lot ON allocations(inventory_lot_id);

CREATE TABLE IF NOT EXISTS measuring_tasks (
  id TEXT PRIMARY KEY,
  picking_order_id TEXT NOT NULL REFERENCES picking_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_measuring_tasks_picking_order
  ON measuring_tasks(picking_order_id);

CREATE TABLE IF NOT EXISTS shipping_boxes (
  id TEXT PRIMARY KEY,
  picking_order_id TEXT REFERENCES picking_orders(id),
  measuring_task_id TEXT REFERENCES measuring_tasks(id),
  status TEXT NOT NULL DEFAULT 'open',
  gross_weight REAL,
  net_weight REAL,
  destination_country TEXT,
  box_size TEXT,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shipping_boxes_task ON shipping_boxes(measuring_task_id);

CREATE TABLE IF NOT EXISTS shipping_box_items (
  id TEXT PRIMARY KEY,
  shipping_box_id TEXT NOT NULL REFERENCES shipping_boxes(id) ON DELETE CASCADE,
  picking_item_id TEXT REFERENCES picking_items(id),
  part_id TEXT NOT NULL REFERENCES parts(id),
  qty INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shipping_box_items_box ON shipping_box_items(shipping_box_id);

CREATE TABLE IF NOT EXISTS shelf_boxes (
  id TEXT PRIMARY KEY,
  receiving_order_id TEXT REFERENCES receiving_orders(id),
  shelf_code TEXT REFERENCES shelves(code),
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shelf_boxes_order ON shelf_boxes(receiving_order_id);
CREATE INDEX IF NOT EXISTS idx_shelf_boxes_shelf ON shelf_boxes(shelf_code);

CREATE TABLE IF NOT EXISTS shelf_box_items (
  id TEXT PRIMARY KEY,
  shelf_box_id TEXT NOT NULL REFERENCES shelf_boxes(id) ON DELETE CASCADE,
  receiving_invoice_item_id TEXT REFERENCES receiving_invoice_items(id),
  part_id TEXT NOT NULL REFERENCES parts(id),
  qty INTEGER NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  verified_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shelf_box_items_box ON shelf_box_items(shelf_box_id);

CREATE TABLE IF NOT EXISTS transition_logs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  metadata TEXT,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transition_logs_entity ON transition_logs(entity_type, entity_id);
`;
