import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

// TIMESTAMP (without tz) columns hold the UTC wall-clock. Two adjustments keep
// Date round-trips timezone-stable:
//  - parse oid 1114 as UTC (postgres.js would parse as local time)
//  - serialize Date params to ISO (drizzle's postgres-js driver replaces the
//    client's parsers/serializers for date/time oids with identity, so a raw
//    `sql` param holding a JS Date would otherwise crash at runtime).
// Must run AFTER drizzle() wraps the client, because drizzle() clobbers these.
function patchTimestampHandling(sql: ReturnType<typeof postgres>): void {
  const options = sql.options as unknown as { parsers: Record<string, (v: string) => unknown>; serializers: Record<string, (v: unknown) => unknown> };
  const parseUtc = (s: string) => new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  const serialize = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  options.parsers["1114"] = parseUtc; // timestamp
  options.parsers["1184"] = parseUtc; // timestamptz (no columns today, safety)
  options.serializers["1114"] = serialize;
  options.serializers["1184"] = serialize;
}

export function createSql(connectionString?: string): ReturnType<typeof postgres> {
  const url = connectionString ?? process.env.DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse_backend";
  return postgres(url, { max: 10 });
}

export function createDb(connectionString?: string): {
  sql: ReturnType<typeof postgres>;
  db: PostgresJsDatabase<typeof schema>;
} {
  const sql = createSql(connectionString);
  const db = drizzle(sql, { schema });
  patchTimestampHandling(sql);
  return { sql, db };
}
