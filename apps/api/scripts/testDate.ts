import { createDb } from "../src/db/client.js";
import { sql } from "drizzle-orm";

const { db, sql: client } = createDb("postgresql://warehouse:warehouse@localhost:5432/warehouse_test");
try {
  await db.execute(sql`INSERT INTO transaction_logs (id, entity_type, entity_id, from_state, to_state, actor_id, metadata, created_at) VALUES ('dt1','x','x',null,'y',null,'{}'::jsonb, now())`);
  console.log("sql now ok");
  await db.execute(sql`INSERT INTO transaction_logs (id, entity_type, entity_id, from_state, to_state, actor_id, metadata, created_at) VALUES ('dt2','x','x',null,'y',null,'{}'::jsonb, ${new Date()})`);
  console.log("Date param ok");
  await db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO transaction_logs (id, entity_type, entity_id, from_state, to_state, actor_id, metadata, created_at) VALUES ('dt3','x','x',null,'y',null,'{}'::jsonb, ${new Date()})`);
  });
  console.log("Date param in tx ok");
} catch (e) {
  console.error("ERROR", e);
} finally {
  await client.end();
}
