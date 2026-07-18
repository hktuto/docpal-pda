import { createTestDb } from "../src/db/test-helper.js";
import { resetTables } from "../src/db/tables.js";
import { recordPutAwayScan } from "../src/db/putAway.js";

const { db, sql: client } = await createTestDb();
await resetTables(db);
const TS = "2026-01-01T00:00:00.000Z";
await db.execute(`INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES ('u1','op','pw','Op','operator','${TS}')`);
await db.execute(`INSERT INTO suppliers (id, code, name) VALUES ('sup','S','Sup')`);
await db.execute(`INSERT INTO receiving_orders (id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','RO-1','in_hand','sup','${TS}','${TS}')`);
await db.execute(`INSERT INTO shelves (code, location_type, created_at, updated_at) VALUES ('A1','shelf','${TS}','${TS}')`);
await db.execute(`INSERT INTO parts (id, part_no) VALUES ('p','X')`);
await db.execute(`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at) VALUES ('inv','ro','INV-1','sup','${TS}','${TS}')`);
await db.execute(`INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty) VALUES ('rii','inv','p',10,10)`);
try {
  const scan = await db.transaction(async (tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 4, dateCode: "D1" }));
  console.log("scan", scan);
} catch (e) {
  console.error("ERROR", e);
} finally {
  await client.end();
}
