import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db/invariants.js";

export function resolveSupplierId(tx: DbOrTx, code: string | null | undefined): string | null {
  if (code == null || code === "") return null;
  const row = tx.get<{ id: string }>(sql`SELECT id FROM suppliers WHERE code = ${code}`);
  if (!row) throw new HTTPException(400, { message: `unknown supplier_code: ${code}` });
  return row.id;
}
