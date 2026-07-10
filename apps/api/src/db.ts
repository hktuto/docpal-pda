import "dotenv/config";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const dbPath = path.resolve(process.env.DATABASE_URL ?? "./dev.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Schema is intentionally empty — the database structure will be rethought later.
export const db = drizzle(sqlite, { schema: {} });
