import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db/invariants.js";
import { queryGet } from "../db/query.js";

export async function resolveSupplierId(tx: DbOrTx, code: string | null | undefined): Promise<string | null> {
  if (code == null || code === "") return null;
  const row = await queryGet<{ id: string }>(tx, sql`SELECT id FROM suppliers WHERE code = ${code}`);
  if (!row) throw new HTTPException(400, { message: `unknown supplier_code: ${code}` });
  return row.id;
}
