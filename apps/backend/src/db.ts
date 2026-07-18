import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db/client.js";
import { seedIfEmpty } from "./db/seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { sql, db } = createDb();

// Migrations are applied automatically on server startup — except on Vercel,
// where every cold start would re-run them; there migrations run explicitly
// via `pnpm db:migrate` (VERCEL is injected by the platform).
if (!process.env.VERCEL) {
  await migrate(db, { migrationsFolder: path.join(__dirname, "../drizzle") });
}

export { sql, db };
export type AppDb = typeof db;

// Auto-seed demo data on an empty database; disable with WAREHOUSE_SEED=off.
// Skipped on Vercel (concurrent cold starts could race the seed; seed once
// manually with `pnpm db:seed`).
if (!process.env.VERCEL && process.env.WAREHOUSE_SEED !== "off") {
  await seedIfEmpty(sql, db);
}
