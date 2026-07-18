import postgres from "postgres";

async function cleanDb(url: string) {
  const sql = postgres(url, { max: 1 });
  try {
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await sql`GRANT ALL ON SCHEMA public TO public`;
    console.log(`cleaned ${url.replace(/\/\/.*?:.*?@/, "//***@")}`);
  } finally {
    await sql.end();
  }
}

const urls = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [process.env.DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse"];

for (const url of urls) {
  await cleanDb(url);
}
