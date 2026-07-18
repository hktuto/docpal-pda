import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";

export type DbOrTx = AppDb | Parameters<Parameters<AppDb["transaction"]>[0]>[0];

export async function queryAll<T>(dbOrTx: DbOrTx, q: ReturnType<typeof sql>): Promise<T[]> {
  const result = await dbOrTx.execute(q);
  return result ? Array.from(result as Iterable<T>) : [];
}

export async function queryGet<T>(dbOrTx: DbOrTx, q: ReturnType<typeof sql>): Promise<T | undefined> {
  const rows = await queryAll<T>(dbOrTx, q);
  return rows[0];
}

export async function queryRun(dbOrTx: DbOrTx, q: ReturnType<typeof sql>): Promise<{ changes: number }> {
  const result = await dbOrTx.execute(q);
  const r = result as any;
  return { changes: r.count ?? r.rowCount ?? (Array.isArray(result) ? result.length : 0) };
}
