import { createDb } from "../src/db/client.js";
import { logTransition } from "../src/ingest/transition.js";

const { db, sql: client } = createDb("postgresql://warehouse:warehouse@localhost:5432/warehouse_test");
try {
  await db.transaction(async (tx) => {
    await logTransition(tx, { entityType: "shelf_box", entityId: "b1", fromState: "open", toState: "closed", actorId: "u1" });
  });
  console.log("logTransition ok");
} catch (e) {
  console.error("ERROR", e);
} finally {
  await client.end();
}
