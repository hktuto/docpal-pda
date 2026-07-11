import "dotenv/config";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import * as schema from "./db/schema/index.js";
import { createDb } from "./db/client.js";
import { createTables } from "./db/tables.js";

const resolved = path.resolve(process.env.DATABASE_URL ?? "./dev.sqlite");
const { sqlite } = createDb(resolved);
createTables(sqlite);

export { sqlite };
export const db = drizzle(sqlite, { schema });
export type AppDb = typeof db;
