import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db/invariants.js";
import { queryGet, queryRun } from "../db/query.js";
import { normalizePartNo } from "../db/schema/normalize.js";
import { now } from "../db/now.js";

export async function resolveOrCreatePart(
  tx: DbOrTx,
  partNo: string,
  description?: string | null,
  supplierId?: string | null
): Promise<string> {
  const norm = normalizePartNo(partNo);
  if (!norm) throw new HTTPException(400, { message: "part_no is required" });
  const existing = await queryGet<{ id: string; description: string | null; partNo: string; supplierId: string | null }>(
    tx,
    sql`SELECT id, description, part_no AS "partNo", supplier_id AS "supplierId" FROM parts WHERE part_no_norm = ${norm} LIMIT 1`
  );
  if (existing) {
    if (description != null && description !== existing.description) {
      await queryRun(tx, sql`UPDATE parts SET description = ${description}, updated_at = ${now()} WHERE id = ${existing.id}`);
    }
    if (supplierId != null && existing.supplierId == null) {
      await queryRun(tx, sql`UPDATE parts SET supplier_id = ${supplierId}, updated_at = ${now()} WHERE id = ${existing.id}`);
    }
    return existing.id;
  }
  const id = crypto.randomUUID();
  await queryRun(
    tx,
    sql`INSERT INTO parts (id, part_no, part_no_norm, description, supplier_id, created_at, updated_at)
        VALUES (${id}, ${partNo}, ${norm}, ${description ?? null}, ${supplierId ?? null}, ${now()}, ${now()})`
  );
  return id;
}
