<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>

<script setup lang="ts">
import { PGlite } from "@electric-sql/pglite";
import { live } from "@electric-sql/pglite/live";
import { providePGlite } from "@electric-sql/pglite-vue";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import { createTablesSql } from "~/db/init";
import { seedDb, ensureDemoPasswords } from "~/db/seed";

const DATA_DIR = "idb://warehouse-demo-pglite";

const pg = new PGlite(DATA_DIR, { extensions: { live } });
providePGlite(pg);

await pg.waitReady;

const { rows: tableCheck } = await pg.query<{ exists: string | null }>(
  "SELECT to_regclass('public.users') AS exists"
);
const isFresh = !tableCheck[0]?.exists;

let drizzleDb: ReturnType<typeof drizzle> | null = null;

if (isFresh) {
  await pg.exec(createTablesSql);
  drizzleDb = drizzle(pg, { schema });
  await seedDb(drizzleDb);
}

// Always make sure the demo accounts use the current demo passwords.
const auth = useAuth();
if (!drizzleDb) {
  drizzleDb = drizzle(pg, { schema });
}
await ensureDemoPasswords(drizzleDb);
await auth.restore(drizzleDb);
</script>
