import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDb } from "./client.js";
import { resetAndReseed } from "./seed.js";
import type { AppDb } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Login is DocPal-only: tests authenticate against a fake DocPal API that
// knows the seeded demo users (operator / admin with their demo passwords and
// group mappings). DOCPAL_URL is set BEFORE db.ts is imported (dotenv/config
// does not override existing env vars). Suites that test the DocPal path
// itself (auth.test.ts) point DOCPAL_URL at their own fake per test.
const DEMO_USERS: Record<string, { password: string; displayName: string; groupId: string }> = {
  operator: { password: "DocPal2026!", displayName: "Demo Operator", groupId: "WMS_PDA_Group_(HK)" },
  admin: { password: "DocPalAdmin2026!", displayName: "Demo Admin", groupId: "WMS_Admin_Group_(HK)" },
};

function startFakeDocpal(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/apis/v1/ucenter/auth/login") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const user = DEMO_USERS[body.username as string];
        if (!user || body.password !== user.password) return json(401, { message: "bad credentials" });
        json(200, { result: true, code: 200, message: "success", data: { access_token: `tok-${body.username}`, refresh_token: "r1" } });
      });
      return;
    }
    if (req.method === "GET" && req.url === "/apis/v1/ucenter/users/application") {
      const username = (req.headers.authorization ?? "").replace("Bearer tok-", "");
      const user = DEMO_USERS[username];
      if (!user) return json(401, { message: "unauthorized" });
      const [firstName, ...rest] = user.displayName.split(" ");
      return json(200, {
        code: 200,
        result: true,
        message: "success",
        data: {
          username,
          userId: username,
          firstName,
          lastName: rest.join(" "),
          aclUserDetail: { groups: [{ groupId: user.groupId, groupName: user.groupId }] },
        },
      });
    }
    json(404, { message: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const fakeDocpal = await startFakeDocpal();
process.env.DOCPAL_URL = fakeDocpal.url;

/** URL of the shared fake DocPal API (restore DOCPAL_URL to this after a test toggles it). */
export const FAKE_DOCPAL_URL = fakeDocpal.url;

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://warehouse:warehouse@localhost:5432/warehouse_backend_test";

let migrated = false;

export interface TestDb {
  sql: ReturnType<typeof createDb>["sql"];
  db: AppDb;
}

/**
 * Wipe + re-seed the demo scenario world (Excel-driven demo dataset:
 * 3 pending receiving orders, 5 picking orders — SO-DEMO-0001 fully
 * allocated (181G×300 line scanned item-by-item, then the rest is a
 * whole-box match), SO-DEMO-0002 partially allocated, SO-DEMO-0003 an
 * exact carton match (pick straight from carton C3001 → prefilled
 * shipping box), SO-DEMO-0004 under-supplied (stays partial),
 * SO-DEMO-0005 split shelf + receiving —
 * and 4 shelf boxes, 3 stocked, 1 empty). Bulk Oracle parts are skipped to keep the
 * reseed fast; the seeded shelf boxes stay because many flows assert on
 * them.
 */
async function reseedTestWorld(client: TestDb): Promise<void> {
  await resetAndReseed(client.sql, client.db, { bulkParts: false });
}

/** Migrate once, then wipe + re-seed the demo dataset. */
export async function setupTestDb(): Promise<TestDb> {
  const client = createDb(TEST_DATABASE_URL);
  if (!migrated) {
    await migrate(client.db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
    migrated = true;
  }
  await reseedTestWorld(client);
  return client;
}

/** Re-seed an existing test client between tests. */
export async function reseed(client: TestDb): Promise<void> {
  await reseedTestWorld(client);
}


