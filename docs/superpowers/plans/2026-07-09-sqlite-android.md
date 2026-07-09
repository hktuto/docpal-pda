# SQLite on Android Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PGlite WASM with native SQLite on Android via `@capacitor-community/sqlite`, preserving the browser demo through a web fallback.

**Architecture:** Introduce a thin `SqliteDatabase` wrapper (`db/sqlite.ts`) used by `useDb()`. Replace `plugins/pglite.client.ts` with `plugins/sqlite.client.ts`. Keep Drizzle schema files for TypeScript types only. Migrate raw SQL in `db/` and `services/adapters/` to SQLite dialect.

**Tech Stack:** Nuxt 3, Vue 3, Capacitor, `@capacitor-community/sqlite`, sql.js web fallback, `uuid`.

---

## Phase 1: Plugin Setup & Proof-of-Concept

### Task 1.1: Install the SQLite plugin

**Files:**
- Modify: `package.json`
- Modify: `capacitor.config.ts`
- Modify: `nuxt.config.ts` (copy wasm to public)

- [ ] **Step 1: Add dependency**

```bash
pnpm add @capacitor-community/sqlite
```

- [ ] **Step 2: Sync native platforms**

```bash
npx cap sync android
```

Expected: plugin installs into `android/capacitor-cordova-android-plugins` and `android/app/src/main/assets`.

- [ ] **Step 3: Configure Capacitor for web fallback**

In `capacitor.config.ts`, add:

```typescript
plugins: {
  SQLite: {
    iosDatabaseLocation: 'Library/SQLite',
    androidDatabaseLocation: 'default',
    webStore: {
      // Use local sql.js assets; see Task 1.4
    },
  },
},
```

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml capacitor.config.ts
git commit -m "deps: add @capacitor-community/sqlite"
```

### Task 1.2: Download sql.js wasm for browser demo

**Files:**
- Create: `public/assets/sql-wasm.wasm`
- Modify: `nuxt.config.ts` (ensure public assets copied)

- [ ] **Step 1: Download the wasm**

```bash
mkdir -p public/assets
pnpm dlx download-file-cli \
  --url="https://sql.js.org/dist/sql-wasm.wasm" \
  --out="public/assets/sql-wasm.wasm"
```

(If the CLI is unavailable, use `curl -L -o public/assets/sql-wasm.wasm https://sql.js.org/dist/sql-wasm.wasm`.)

- [ ] **Step 2: Verify file size**

```bash
ls -lh public/assets/sql-wasm.wasm
```

Expected: ~6 MB.

- [ ] **Step 3: Commit**

```bash
git add public/assets/sql-wasm.wasm nuxt.config.ts
git commit -m "assets: add sql.js wasm for browser sqlite fallback"
```

### Task 1.3: Create a throw-away SQLite test page

**Files:**
- Create: `pages/test-sqlite.vue` (temporary, deleted before merge)

- [ ] **Step 1: Write test page**

```vue
<template>
  <div>
    <h1>SQLite POC</h1>
    <button @click="runTest">Run Test</button>
    <pre>{{ result }}</pre>
  </div>
</template>

<script setup lang="ts">
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const result = ref('');

async function runTest() {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const db = await sqlite.createConnection('warehouse-poc', false, 'no-encryption', 1, false);
  await db.open();
  await db.execute('CREATE TABLE IF NOT EXISTS test (id TEXT PRIMARY KEY, name TEXT)');
  await db.run('INSERT OR REPLACE INTO test (id, name) VALUES (?, ?)', ['1', 'hello']);
  const res = await db.query('SELECT * FROM test WHERE id = ?', ['1']);
  result.value = JSON.stringify(res.values, null, 2);
  await db.close();
}
</script>
```

- [ ] **Step 2: Build, sync, install**

```bash
pnpm generate
npx cap sync android
cd android && ./gradlew :app:installDebug
```

- [ ] **Step 3: Verify on device**

Navigate to `/test-sqlite`, tap **Run Test**. Expected: `{"values": [{"id":"1","name":"hello"}]}`.

- [ ] **Step 4: Commit (temporary file)**

```bash
git add pages/test-sqlite.vue
git commit -m "poc: temporary sqlite test page"
```

---

## Phase 2: SQLite Database Wrapper & Schema

### Task 2.1: Create the SQLite wrapper

**Files:**
- Create: `db/sqlite.ts`

- [ ] **Step 1: Write wrapper**

```typescript
import type { SQLiteDBConnection, SQLiteConnection } from '@capacitor-community/sqlite';

export interface SqliteQueryResult<T = Record<string, unknown>> {
  rows: T[];
}

export interface SqliteRunResult {
  changes: number;
  lastInsertRowId: number;
}

export interface SqliteTransaction {
  query<T>(sql: string, params?: unknown[]): Promise<SqliteQueryResult<T>>;
  run(sql: string, params?: unknown[]): Promise<SqliteRunResult>;
}

export class SqliteDatabase {
  constructor(private db: SQLiteDBConnection) {}

  async exec(sql: string): Promise<void> {
    await this.db.execute(sql);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqliteQueryResult<T>> {
    const result = await this.db.query(sql, params ?? []);
    return { rows: (result.values ?? []) as T[] };
  }

  async run(sql: string, params?: unknown[]): Promise<SqliteRunResult> {
    const result = await this.db.run(sql, params ?? [], false);
    return {
      changes: result.changes?.changes ?? 0,
      lastInsertRowId: result.changes?.lastId ?? 0,
    };
  }

  async transaction<T>(fn: (tx: SqliteTransaction) => Promise<T>): Promise<T> {
    await this.db.execute('BEGIN TRANSACTION');
    try {
      const tx: SqliteTransaction = {
        query: async (sql, params) => this.query(sql, params),
        run: async (sql, params) => this.run(sql, params),
      };
      const result = await fn(tx);
      await this.db.execute('COMMIT');
      return result;
    } catch (e) {
      await this.db.execute('ROLLBACK');
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export async function openSqlite(
  connection: SQLiteConnection,
  name: string,
  version: number
): Promise<SqliteDatabase> {
  const db = await connection.createConnection(name, false, 'no-encryption', version, false);
  await db.open();
  return new SqliteDatabase(db);
}
```

- [ ] **Step 2: Add unit test for wrapper**

Create `tests/sqliteWrapper.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteDatabase } from '../db/sqlite';

// Mock minimal SQLiteDBConnection
function createMockDb() {
  const tables: Record<string, Record<string, unknown>[]> = {};
  return {
    execute: async (sql: string) => {
      const match = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      if (match) tables[match[1]] = [];
    },
    query: async (sql: string, params: unknown[]) => {
      const match = sql.match(/SELECT \* FROM (\w+) WHERE id = \?/);
      if (match) {
        return { values: tables[match[1]].filter((r) => r.id === params[0]) };
      }
      return { values: [] };
    },
    run: async (sql: string, params: unknown[]) => {
      const match = sql.match(/INSERT OR REPLACE INTO (\w+) \(([^)]+)\) VALUES \([^?]+\?[^?]*\)/);
      if (match) {
        const table = match[1];
        const keys = match[2].split(',').map((k) => k.trim());
        tables[table].push(Object.fromEntries(keys.map((k, i) => [k, params[i]])));
      }
      return { changes: { changes: 1, lastId: 1 } };
    },
  } as unknown as SQLiteDBConnection;
}

describe('SqliteDatabase wrapper', () => {
  it('executes, runs, and queries', async () => {
    const db = new SqliteDatabase(createMockDb());
    await db.exec('CREATE TABLE IF NOT EXISTS test (id TEXT PRIMARY KEY, name TEXT)');
    await db.run('INSERT OR REPLACE INTO test (id, name) VALUES (?, ?)', ['1', 'hello']);
    const res = await db.query<{ id: string; name: string }>('SELECT * FROM test WHERE id = ?', ['1']);
    expect(res.rows).toEqual([{ id: '1', name: 'hello' }]);
  });
});
```

Run:

```bash
pnpm test tests/sqliteWrapper.test.ts
```

Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add db/sqlite.ts tests/sqliteWrapper.test.ts
git commit -m "feat(sqlite): add SqliteDatabase wrapper"
```

### Task 2.2: Create SQLite-compatible schema SQL

**Files:**
- Create: `db/sqliteInit.ts`

- [ ] **Step 1: Translate `db/init.ts` to SQLite**

Copy `db/init.ts` to `db/sqliteInit.ts` and make the following substitutions:

```typescript
export const createTablesSql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  qrcode_template TEXT,
  qrcode_qty_encoding TEXT
);

CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY,
  part_no TEXT NOT NULL UNIQUE,
  internal_code TEXT,
  description TEXT,
  default_coo TEXT
);

-- ... continue translating every table from db/init.ts ...
-- Key rules:
--   - Replace TIMESTAMP with TEXT
--   - Replace BOOLEAN with INTEGER
--   - Replace jsonb with TEXT
--   - Keep TEXT/INTEGER as-is
--   - Keep indexes
`;
```

For every table, use the same structure as `db/init.ts` but with SQLite types.

- [ ] **Step 2: Add a schema smoke test**

Create `tests/sqliteSchema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { createTablesSql } from '../db/sqliteInit';

describe('sqlite schema', () => {
  it('executes without error', async () => {
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    const db = await sqlite.createConnection('test-schema', true, 'no-encryption', 1, true);
    await db.open();
    await db.execute(createTablesSql);
    const tables = await db.query("SELECT name FROM sqlite_master WHERE type='table'");
    expect(tables.values?.some((t) => t.name === 'users')).toBe(true);
    await db.close();
  });
});
```

Run:

```bash
pnpm test tests/sqliteSchema.test.ts
```

Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add db/sqliteInit.ts tests/sqliteSchema.test.ts
git commit -m "feat(sqlite): add sqlite-compatible schema"
```

### Task 2.3: Create the SQLite Nuxt plugin

**Files:**
- Create: `plugins/sqlite.client.ts`
- Delete: `plugins/pglite.client.ts`

- [ ] **Step 1: Write plugin**

```typescript
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { openSqlite, SqliteDatabase } from '~/db/sqlite';
import { createTablesSql } from '~/db/sqliteInit';
import { seedDb as seedDbDefault, ensureDemoPasswords as ensureDemoPasswordsDefault } from '~/db/seed';
import { seedDb as seedDbPrecalc, ensureDemoPasswords as ensureDemoPasswordsPrecalc } from '~/db/seed-precalc';

const DB_NAME = 'warehouse-demo';
const DB_VERSION = 1;

export default defineNuxtPlugin(async () => {
  const config = useRuntimeConfig();
  const usePrecalc = config.public.seedPreset === 'precalc';
  const seedDb = usePrecalc ? seedDbPrecalc : seedDbDefault;
  const ensureDemoPasswords = usePrecalc ? ensureDemoPasswordsPrecalc : ensureDemoPasswordsDefault;

  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const db = await openSqlite(sqlite, DB_NAME, DB_VERSION);

  const tableCheck = await db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  );
  const usersTableExists = tableCheck.rows.length > 0;

  let userCount = 0;
  if (usersTableExists) {
    const countRows = await db.query<{ count: string }>('SELECT CAST(COUNT(*) AS TEXT) AS count FROM users');
    userCount = Number(countRows.rows[0]?.count ?? 0);
  }

  const needsSeed = !usersTableExists || userCount === 0;

  if (needsSeed) {
    if (!usersTableExists) {
      await db.exec(createTablesSql);
    }
    await seedDb(db);
  }

  await ensureDemoPasswords(db);

  return {
    provide: {
      sqliteDb: db,
    },
  };
});
```

- [ ] **Step 2: Update `useDb.ts`**

Modify `composables/useDb.ts`:

```typescript
import { SqliteDatabase } from '~/db/sqlite';

let dbInstance: SqliteDatabase | null = null;

export function useDb(): SqliteDatabase {
  if (dbInstance) return dbInstance;

  const nuxtApp = useNuxtApp();
  const db = nuxtApp.$sqliteDb as SqliteDatabase | undefined;
  if (!db) {
    throw new Error('SQLite database is not available. Make sure the sqlite.client.ts plugin is loaded.');
  }

  dbInstance = db;
  return dbInstance;
}
```

- [ ] **Step 3: Remove old plugin**

```bash
rm plugins/pglite.client.ts
```

- [ ] **Step 4: Update runtime config label**

In `nuxt.config.ts`, change:

```typescript
warehouseAdapter: "sqlite", // "sqlite" | "api"
```

(Keep `pglite` backward-compatible if desired, but default to `sqlite`.)

- [ ] **Step 5: Commit**

```bash
git add plugins/sqlite.client.ts composables/useDb.ts nuxt.config.ts
git rm plugins/pglite.client.ts
git commit -m "feat(sqlite): replace pglite plugin with sqlite plugin"
```

---

## Phase 3: SQL Dialect Helpers

### Task 3.1: Create SQLite dialect helpers

**Files:**
- Create: `db/sqliteDialect.ts`

- [ ] **Step 1: Write helpers**

```typescript
/**
 * SQLite-compatible regexp replace.
 * Only handles the patterns we use: collapsing whitespace, digit substitutions.
 */
export function regexpReplace(value: string, pattern: string, replacement: string, flags?: string): string {
  // For whitespace collapse used across the app
  if (pattern === '\\s+' && replacement === ' ' && flags?.includes('g')) {
    return `TRIM(${value})`; // if used with UPPER, caller wraps: UPPER(TRIM(...))
  }
  // Fallback: chain REPLACE for common single-char patterns
  throw new Error(`Unsupported regexp pattern for SQLite: ${pattern}`);
}

/**
 * Normalize a text column: trim, uppercase, collapse spaces.
 */
export function normalizeColumn(column: string): string {
  return `UPPER(TRIM(REPLACE(REPLACE(REPLACE(${column}, CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' ')))`;
}

/**
 * Common OCR digit substitutions on a normalized value.
 */
export function ocrDigitSubstitutions(value: string): string {
  return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${value}, 'O', '0'), 'I', '1'), 'L', '1'), 'Z', '2'), 'S', '5')`;
}

/**
 * Cast count to text, matching old Postgres behavior.
 */
export function countText(column = '*'): string {
  return `CAST(COUNT(${column}) AS TEXT)`;
}
```

- [ ] **Step 2: Commit**

```bash
git add db/sqliteDialect.ts
git commit -m "feat(sqlite): add sqlite sql dialect helpers"
```

---

## Phase 4: Seed Data

### Task 4.1: Rewrite seed helpers for SQLite

**Files:**
- Modify: `db/seed.ts`
- Modify: `db/seed-precalc.ts`

- [ ] **Step 1: Replace Drizzle inserts with bulk SQL inserts**

For each seed file, change helpers from:

```typescript
await db.insert(schema.users).values(users);
```

To:

```typescript
async function insertUsers(db: SqliteDatabase, users: User[]) {
  if (users.length === 0) return;
  const values = users.map((u) => `('${u.id}', '${u.username}', '${u.passwordHash}', '${u.displayName}', '${u.role}', '${u.createdAt.toISOString()}')`).join(',');
  await db.exec(`INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES ${values}`);
}
```

Use parameterized queries instead of string interpolation to handle quotes safely:

```typescript
async function insertUsers(db: SqliteDatabase, users: User[]) {
  if (users.length === 0) return;
  const placeholders = users.map(() => '(?, ?, ?, ?, ?, ?)').join(',');
  const params = users.flatMap((u) => [u.id, u.username, u.passwordHash, u.displayName, u.role, u.createdAt.toISOString()]);
  await db.run(`INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES ${placeholders}`, params);
}
```

- [ ] **Step 2: Update `ensureDemoPasswords`**

Change from Drizzle update to:

```typescript
await db.run("UPDATE users SET password_hash = ? WHERE username = ?", [hash, 'operator']);
```

- [ ] **Step 3: Commit**

```bash
git add db/seed.ts db/seed-precalc.ts
git commit -m "feat(sqlite): rewrite seed scripts for sqlite"
```

---

## Phase 5: Migrate DB Helpers

### Task 5.1: Establish migration order

Migrate files in `db/` in this order (fewest dependencies first):

1. `db/suppliers.ts`
2. `db/stockSearch.ts`
3. `db/receiving.ts`
4. `db/mismatch.ts`
5. `db/picking.ts`
6. `db/putAway.ts`
7. `db/measuring.ts`
8. `db/goodsVerify.ts`
9. `db/ocrPicking.ts`
10. `db/helpers.ts`

For each file:
- Replace `drizzle-orm` SQL templates with strings/functions that produce SQLite SQL.
- Replace `db.execute(sql\`...\`)` with `db.query(...)` / `db.run(...)`.
- Replace `to_regclass`, `::text`, `REGEXP_REPLACE`, etc.
- Update corresponding tests.

### Task 5.2: Migrate `db/suppliers.ts`

**Files:**
- Modify: `db/suppliers.ts`

- [ ] **Step 1: Rewrite query**

```typescript
export async function getSuppliersWithQrTemplates(db: SqliteDatabase): Promise<SupplierQrcodeTemplate[]> {
  const rows = await db.query<{ code: string; qrcode_template: string; qrcode_qty_encoding: string | null }>(
    `SELECT code, qrcode_template, qrcode_qty_encoding
     FROM suppliers
     WHERE qrcode_template IS NOT NULL`
  );
  return rows.rows.map((r) => ({
    code: r.code,
    qrcodeTemplate: r.qrcode_template,
    qrcodeQtyEncoding: r.qrcode_qty_encoding ?? null,
  }));
}
```

- [ ] **Step 2: Commit**

```bash
git add db/suppliers.ts
git commit -m "feat(sqlite): migrate suppliers helpers to sqlite"
```

### Task 5.3: Migrate `db/ocrPicking.ts`

**Files:**
- Modify: `db/ocrPicking.ts`

- [ ] **Step 1: Rewrite `findReceivingCandidates`**

Use the helpers from `db/sqliteDialect.ts`:

```typescript
const partNoMatch = `${ocrDigitSubstitutions(normalizeColumn('p.part_no'))} = ?`;
```

And pass `[parsed.partNo]` as parameter.

Replace the CTEs with SQLite-compatible SQL. Use `normalizeColumn` and `ocrDigitSubstitutions` for date/lot codes.

- [ ] **Step 2: Rewrite `findPickingCandidates`**

Use EXISTS pattern from the query optimization work.

- [ ] **Step 3: Update `applyOcrPick`**

Replace Drizzle `tx.select().from().where()` with `tx.query(...)` calls.

- [ ] **Step 4: Commit**

```bash
git add db/ocrPicking.ts
git commit -m "feat(sqlite): migrate ocrPicking helpers to sqlite"
```

### Task 5.4: Repeat for remaining DB helpers

For each remaining file in the order from Task 5.1:

- [ ] Rewrite raw SQL to SQLite dialect.
- [ ] Replace Drizzle API calls with `db.query` / `db.run`.
- [ ] Update imports to use `SqliteDatabase` from `~/db/sqlite`.
- [ ] Run focused tests if they exist.
- [ ] Commit.

---

## Phase 6: Migrate Warehouse Adapter

### Task 6.1: Update `services/adapters/pgliteWarehouse.ts`

**Files:**
- Modify: `services/adapters/pgliteWarehouse.ts`

- [ ] **Step 1: Rename file to `sqliteWarehouse.ts`**

```bash
git mv services/adapters/pgliteWarehouse.ts services/adapters/sqliteWarehouse.ts
```

- [ ] **Step 2: Update imports**

Replace `import { sql } from 'drizzle-orm'` with dialect helpers.
Replace `useDb` return type expectations.

- [ ] **Step 3: Migrate raw SQL blocks**

For each `sql\`...\`` block:
- Replace Postgres functions with SQLite equivalents.
- Replace `db.execute(sql\`...\`)` with `db.query(sql, params)`.

This is the largest file (1300+ lines). Migrate function-by-function, committing every 2-3 functions.

### Task 6.2: Update warehouse service factory

**Files:**
- Modify: `services/warehouse.ts`

- [ ] **Step 1: Switch adapter import**

```typescript
import { createSqliteWarehouseService } from './adapters/sqliteWarehouse';

export function createWarehouseService(options: CreateWarehouseServiceOptions): WarehouseService {
  if (options.adapter === 'api') {
    return createApiWarehouseService(options);
  }
  return createSqliteWarehouseService();
}
```

- [ ] **Step 2: Commit**

```bash
git add services/warehouse.ts services/adapters/sqliteWarehouse.ts
git commit -m "feat(sqlite): wire sqlite warehouse adapter"
```

---

## Phase 7: Tests, Cleanup & Verification

### Task 7.1: Update existing tests

**Files:**
- Modify: all `tests/*.test.ts` that use PGlite

- [ ] **Step 1: Replace test DB setup**

In each test file, replace:

```typescript
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createTablesSql } from '../db/init';

async function createTestDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(createTablesSql);
  return drizzle(pg, { schema });
}
```

With:

```typescript
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { SqliteDatabase } from '../db/sqlite';
import { createTablesSql } from '../db/sqliteInit';

async function createTestDb() {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const conn = await sqlite.createConnection('test-' + Date.now(), true, 'no-encryption', 1, true);
  await conn.open();
  const db = new SqliteDatabase(conn);
  await db.exec(createTablesSql);
  return db;
}
```

- [ ] **Step 2: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "test(sqlite): migrate tests to sqlite"
```

### Task 7.2: Remove temporary POC page and timing logs

**Files:**
- Delete: `pages/test-sqlite.vue`
- Modify: `composables/useHardwareScanner.ts`
- Modify: `composables/useLabelScan.ts`
- Modify: `composables/useScanMatchers.ts`
- Modify: `db/ocrPicking.ts`

- [ ] **Step 1: Delete test page**

```bash
rm pages/test-sqlite.vue
git rm pages/test-sqlite.vue
```

- [ ] **Step 2: Remove `[SCAN-TIME]` console logs**

Strip all timing instrumentation added during profiling.

- [ ] **Step 3: Commit**

```bash
git add composables/useHardwareScanner.ts composables/useLabelScan.ts composables/useScanMatchers.ts db/ocrPicking.ts
git commit -m "chore(sqlite): remove poc page and scan timing logs"
```

### Task 7.3: End-to-end verification on Android

- [ ] **Step 1: Generate and sync**

```bash
pnpm generate
npx cap sync android
```

- [ ] **Step 2: Install debug APK**

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:installDebug
```

- [ ] **Step 3: Clear app data on device**

```bash
'/d/android/platform-tools/adb.exe' shell pm clear com.docpal.warehousedemo
```

- [ ] **Step 4: Launch and smoke test**

```bash
'/d/android/platform-tools/adb.exe' shell am start -n com.docpal.warehousedemo/.MainActivity
```

- Log in as `operator` / `DocPal2026!`.
- Open a receiving order.
- Scan an item with the IR scanner.
- Measure: dialog should open in <1 s (target <500 ms DB time).

- [ ] **Step 5: Browser smoke test**

```bash
pnpm dev
```

Open `http://localhost:3000`, log in, open receiving order, verify app loads.

- [ ] **Step 6: Commit final verification notes**

```bash
git commit --allow-empty -m "verify(sqlite): android and browser smoke tests pass"
```

### Task 7.4: Update documentation

**Files:**
- Modify: `docs/app-docs/ai/feature-registry.md`
- Modify: `docs/app-docs/ai/code-map.md`
- Modify: `AGENTS.md` (commands if needed)

- [ ] **Step 1: Document SQLite layer**

Add entries for:
- `db/sqlite.ts`
- `db/sqliteInit.ts`
- `db/sqliteDialect.ts`
- `plugins/sqlite.client.ts`

- [ ] **Step 2: Commit**

```bash
git add docs/app-docs/ai/feature-registry.md docs/app-docs/ai/code-map.md AGENTS.md
git commit -m "docs(sqlite): update ai docs for sqlite layer"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-09-sqlite-android.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach do you want?
