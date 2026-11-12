import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { actorFrom } from "../../auth/middleware.js";
import { newId } from "../../db/id.js";
import { transactionLogs } from "../../db/schema/index.js";

/**
 * POST /admin/uat/inventory-wipe — UAT-only destructive reset of all on-hand
 * inventory state (spec 2026-11-13-uat-inventory-tools-design.md). Registered
 * only when UAT_TOOLS=1 (admin/index.ts). One transaction:
 *   1. allocations (all rows — they reference lots via ON DELETE CASCADE, but
 *      wiping them explicitly also clears lot-less reservations)
 *   2. inventory_lot_sources (explicit; also cascades from lots)
 *   3. goods_verify_tasks.inventory_lot_id → NULL (column is nullable +
 *      legacy per the 2026-10-17 redesign; the tasks themselves are daily
 *      confirmation records that stay)
 *   4. inventory_transactions  5. transaction_logs  6. inventory_lots
 * The sync-service event feed is silenced (SET LOCAL app.sync_events_off = 1)
 * like resetAndReseed (src/db/seed.ts) so the wipe doesn't flood it.
 */
export const uatInventoryWipeRoute = new Hono();

uatInventoryWipeRoute.post("/", async (c) => {
  const actorId = actorFrom(c).id;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.sync_events_off = 1`);
    await tx.execute(sql`DELETE FROM allocations`);
    await tx.execute(sql`DELETE FROM inventory_lot_sources`);
    await tx.execute(
      sql`UPDATE goods_verify_tasks SET inventory_lot_id = NULL, last_update_date = now()
          WHERE inventory_lot_id IS NOT NULL`
    );
    await tx.execute(sql`DELETE FROM inventory_transactions`);
    await tx.execute(sql`DELETE FROM transaction_logs`);
    const lots = await tx.execute(sql`DELETE FROM inventory_lots`);
    const deletedLots = lots.count ?? 0;
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "uat_inventory_wipe",
      entityId: "all",
      fromState: null,
      toState: "wiped",
      actorId,
      metadata: { deletedLots },
    });
    return { deletedLots };
  });
  return c.json({ ok: true, deletedLots: result.deletedLots });
});
