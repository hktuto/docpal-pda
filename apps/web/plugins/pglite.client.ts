import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import { createTablesSql } from "~/db/init";
import { seedDb as seedDbDefault, ensureDemoPasswords as ensureDemoPasswordsDefault } from "~/db/seed";
import { seedDb as seedDbPrecalc, ensureDemoPasswords as ensureDemoPasswordsPrecalc } from "~/db/seed-precalc";

export default defineNuxtPlugin(async () => {
  const config = useRuntimeConfig();

  // When the app talks to the real API, PGlite must not boot at all.
  // (The static imports above stay — the WASM chunk is accepted dead weight.)
  if (config.public.warehouseAdapter !== "pglite") {
    return;
  }

  const usePrecalc = config.public.seedPreset === "precalc";
  const seedDb = usePrecalc ? seedDbPrecalc : seedDbDefault;
  const ensureDemoPasswords = usePrecalc ? ensureDemoPasswordsPrecalc : ensureDemoPasswordsDefault;

  const pg = new PGlite();

  await pg.waitReady;

  const { rows: tableCheck } = await pg.query<{ exists: string | null }>(
    "SELECT to_regclass('public.users') AS exists"
  );
  const usersTableExists = !!tableCheck[0]?.exists;

  let userCount = 0;
  if (usersTableExists) {
    const { rows: countRows } = await pg.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM users"
    );
    userCount = Number(countRows[0]?.count ?? 0);
  }

  const needsSeed = !usersTableExists || userCount === 0;
  const db = drizzle(pg, { schema });

  if (needsSeed) {
    if (!usersTableExists) {
      await pg.exec(createTablesSql);
    }
    await seedDb(db);
  }

  // Always make sure the demo accounts use the current demo passwords.
  await ensureDemoPasswords(db);

  return {
    provide: {
      pglite: pg,
    },
  };
});
