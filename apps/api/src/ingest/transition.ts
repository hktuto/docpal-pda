import { sql } from "drizzle-orm";
import type { DbOrTx } from "../db/query.js";
import { queryRun } from "../db/query.js";
import { now } from "../db/now.js";

export async function logTransition(
  tx: DbOrTx,
  t: { entityType: string; entityId: string; fromState?: string | null; toState?: string | null; actorId?: string | null; metadata?: Record<string, unknown> }
): Promise<void> {
  await queryRun(
    tx,
    sql`INSERT INTO transaction_logs (id, entity_type, entity_id, from_state, to_state, actor_id, metadata, created_at)
        VALUES (${crypto.randomUUID()}, ${t.entityType}, ${t.entityId}, ${t.fromState ?? null}, ${t.toState ?? null},
                ${t.actorId ?? null}, ${JSON.stringify(t.metadata ?? {})}, ${now()})`
  );
}
