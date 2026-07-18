import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db/client.js";
import { resetAndReseed } from "./db/seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CLI: pnpm db:seed — migrate, wipe, and re-seed the demo dataset.
const { sql, db } = createDb();
await migrate(db, { migrationsFolder: path.join(__dirname, "../drizzle") });
await resetAndReseed(sql, db);
console.log("seed complete");
await sql.end();
