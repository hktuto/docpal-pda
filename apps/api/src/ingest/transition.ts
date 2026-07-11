import { sql } from "drizzle-orm";
import type { DbOrTx } from "../db/invariants.js";
import { now } from "../db/now.js";

export function logTransition(
  tx: DbOrTx,
  t: { entityType: string; entityId: string; fromStatus?: string | null; toStatus?: string | null; actorId?: string | null; note?: string | null }
): void {
  tx.run(
    sql`INSERT INTO transition_logs (id, entity_type, entity_id, from_status, to_status, actor_id, note, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${t.entityType}, ${t.entityId}, ${t.fromStatus ?? null}, ${t.toStatus ?? null},
                ${t.actorId ?? null}, ${t.note ?? null}, ${now()}, ${now()})`
  );
}
