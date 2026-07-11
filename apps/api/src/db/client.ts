import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export function createDb(dbPath?: string): {
  sqlite: DatabaseType;
  db: BetterSQLite3Database<Record<string, never>>;
} {
  const resolved = path.resolve(dbPath ?? process.env.DATABASE_URL ?? "./dev.sqlite");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const sqlite = new Database(resolved);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  return { sqlite, db };
}
