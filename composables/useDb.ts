import { injectPGlite } from "@electric-sql/pglite-vue";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";

let dbInstance: PgliteDatabase<typeof schema> | null = null;

export function useDb() {
  if (dbInstance) return dbInstance;

  const pg = injectPGlite();
  if (!pg) {
    throw new Error(
      "PGlite is not available. Make sure the pglite.client.ts plugin is loaded."
    );
  }

  dbInstance = drizzle(pg, { schema });
  return dbInstance;
}
