import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db/invariants.js";
import { normalizePartNo } from "../db/schema/normalize.js";
import { now } from "../db/now.js";

export function resolveOrCreatePart(tx: DbOrTx, partNo: string, description?: string | null): string {
  const norm = normalizePartNo(partNo);
  if (!norm) throw new HTTPException(400, { message: "part_no is required" });
  const existing = tx.get<{ id: string; description: string | null; partNo: string }>(
    sql`SELECT id, description, part_no AS partNo FROM parts WHERE part_no_norm = ${norm} LIMIT 1`
  );
  if (existing) {
    if (description != null && description !== existing.description) {
      tx.run(sql`UPDATE parts SET description = ${description}, updated_at = ${now()} WHERE id = ${existing.id}`);
    }
    return existing.id;
  }
  const id = crypto.randomUUID();
  tx.run(
    sql`INSERT INTO parts (id, part_no, part_no_norm, description, created_at, updated_at)
        VALUES (${id}, ${partNo}, ${norm}, ${description ?? null}, ${now()}, ${now()})`
  );
  return id;
}
