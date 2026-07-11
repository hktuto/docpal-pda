import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { createShelfBox, cancelShelfBox } from "./putAway.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','e','RO-1','in_hand','sup','0','0');
    INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
  `);
  return { sqlite, db };
}

test("createShelfBox creates an open box scoped to the order + shelf; cancelShelfBox deletes an empty open box", () => {
  const { sqlite, db } = makeDb();
  const { id } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1", actorId: "u1" }));
  assert.match(id, /^SBOX-\d{4}$/);
  const box = sqlite.prepare("SELECT receiving_order_id, shelf_code, status FROM shelf_boxes WHERE id=?").get(id) as any;
  assert.deepEqual(box, { receiving_order_id: "ro", shelf_code: "A1", status: "open" });
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shelf_box' AND to_status='open'").get() as any).c, 1);

  db.transaction((tx) => cancelShelfBox(tx, { shelfBoxId: id, actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM shelf_boxes WHERE id=?").get(id) as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("create/cancel guards: 404 order, 404 shelf, 409 cancel non-open", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "nope", shelfCode: "A1" })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "ZZ" })), (e: any) => e.status === 404);
  const { id } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  sqlite.prepare("UPDATE shelf_boxes SET status='closed' WHERE id=?").run(id);
  assert.throws(() => db.transaction((tx) => cancelShelfBox(tx, { shelfBoxId: id })), (e: any) => e.status === 409); // not open
  sqlite.close();
});
