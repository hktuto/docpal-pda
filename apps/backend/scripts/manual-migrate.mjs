// Manual migration runner for environments where drizzle-kit is not installed
// (e.g. the production backend image). Verified usage against the prod
// compose stack (run from the repo root; MSYS_NO_PATHCONV is a Git Bash
// workaround so the Windows mount paths reach Docker Desktop unmangled):
//
//   MSYS_NO_PATHCONV=1 docker run --rm --network warehouse-prod_default --env-file .env \
//     -v "D:/work/docpal/warehouse-pda/apps/backend/scripts:/app/scripts:ro" \
//     -v "D:/work/docpal/warehouse-pda/apps/backend/drizzle:/mig:ro" \
//     warehouse-prod-backend \
//     sh -c 'DATABASE_URL="postgresql://warehouse:${POSTGRES_PASSWORD}@db:5432/warehouse_backend" node /app/scripts/manual-migrate.mjs'
//
// The script must be mounted UNDER /app so its bare imports resolve from the
// image's own node_modules (drizzle-orm + postgres ship as prod deps).
// Applying already-applied migrations is a no-op.
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL);
await migrate(drizzle(sql), { migrationsFolder: process.env.MIGRATIONS_FOLDER ?? "/mig" });
await sql.end();
console.log("migrations applied (or already up to date)");
