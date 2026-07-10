# pnpm Workspace + Hono API (SQLite) Bootstrap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the repo into a pnpm monorepo (`apps/web`, `apps/api`, `packages/shared`), scaffold a Hono API with a schema-less SQLite connection and a `/health` route, and remove `native-android/` — with zero behavior change to the existing Nuxt/PGlite frontend.

**Architecture:** Three workspace packages. The existing Nuxt app moves wholesale into `apps/web` (still on PGlite, `warehouseAdapter: "pglite"`). A new `apps/api` runs Hono on `@hono/node-server` with `better-sqlite3` + Drizzle (empty schema) and exposes only `GET /health`. `packages/shared` holds shared types (just `HealthResponse` for now). Root becomes a thin orchestrator whose scripts delegate via `pnpm --filter`.

**Tech Stack:** pnpm workspaces, Nuxt 3 (unchanged), Hono, @hono/node-server, better-sqlite3, drizzle-orm (better-sqlite3 driver), dotenv, tsx, TypeScript, Node built-in `node:test` for the API test.

**Spec:** `docs/superpowers/specs/2026-07-10-pnpm-workspace-hono-api-design.md`

---

## File structure

```
warehouse-pda/
  package.json                       REWRITE → lean workspace root (scripts only)
  pnpm-workspace.yaml                MODIFY → ["apps/*", "packages/*"]
  .gitignore                         MODIFY → ignore *.sqlite (+ wal/shm)
  apps/
    web/                             ← entire existing Nuxt app moved here (git mv)
      package.json                   MODIFY → name @warehouse/web, add @warehouse/shared dep
      android/                       ← moved here with the app (Capacitor shell)
      (all other existing app files, unchanged)
    api/
      package.json                   CREATE → @warehouse/api
      tsconfig.json                  CREATE
      .env.example                   CREATE
      drizzle/.gitkeep               CREATE
      src/
        db.ts                        CREATE → better-sqlite3 + drizzle (empty schema)
        index.ts                     CREATE → Hono app, CORS, route mount (exports `app`)
        server.ts                    CREATE → dotenv + node-server listen
        routes/health.ts             CREATE → GET /health (pings SQLite)
        health.test.ts               CREATE → node:test for /health
  packages/
    shared/
      package.json                   CREATE → @warehouse/shared
      tsconfig.json                  CREATE
      src/index.ts                   CREATE → HealthResponse type
  native-android/                    DELETE (git rm -r + remove untracked build output)
```

Notes:
- `packages/shared` is consumed via **type-only** imports in this iteration (`import type { HealthResponse }`). It therefore exports its `.ts` source directly and needs no build step for consumers. Runtime shared values are deferred until `shared` gets a real build.
- Deviation from the spec: the spec listed an `API_BASE_PATH` constant in `shared`. Exporting a runtime value from a source-only `shared` package would break the API's plain-`node` production build (`node dist/server.js` cannot import a `.ts` re-export). The base path therefore lives in `apps/api` (env + `index.ts`) for now and moves to `shared` together with the DTOs when `shared` gains a real build. `shared` ships the `HealthResponse` type only in this iteration.
- `apps/api` `index.ts` exports `app` without listening; `server.ts` is the only file that calls `serve(...)`. This lets the test import `app` directly.

---

## Task 1: Remove `native-android/`

**Files:**
- Delete: `native-android/` (58 tracked files + untracked Gradle output)

- [ ] **Step 1: Confirm nothing in the app references `native-android`**

Run:
```bash
grep -RIl --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=native-android "native-android" . || true
```
Expected: no matches (or only inside `docs/` history). If a live reference appears, stop and flag it.

- [ ] **Step 2: Remove tracked files**

Run:
```bash
git rm -r native-android
```
Expected: `rm 'native-android/...'` lines for the tracked files.

- [ ] **Step 3: Remove remaining untracked build output**

Run:
```bash
rm -rf native-android
```
Expected: directory gone. `ls native-android` → "No such file or directory".

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove obsolete native-android Kotlin project"
```

---

## Task 2: Move frontend to `apps/web` and set up the workspace root

**Files:**
- Move (git mv): `app.vue`, `assets`, `components`, `composables`, `constants`, `db`, `i18n`, `layouts`, `middleware`, `pages`, `plugins`, `public`, `resources`, `scripts`, `services`, `tests`, `types`, `utils`, `nuxt.config.ts`, `capacitor.config.ts`, `tsconfig.json`, `vitest.config.ts`, `vitest.generator.config.ts`, `package.json`, `android` → into `apps/web/`
- Create: new lean root `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `apps/web/package.json` (rename + add shared dep)
- Modify: `.gitignore`

- [ ] **Step 1: Create package directories**

```bash
mkdir -p apps/web apps/api packages/shared
```

- [ ] **Step 2: Move the frontend into `apps/web`**

```bash
git mv app.vue assets components composables constants db i18n layouts middleware pages plugins public resources scripts services tests types utils nuxt.config.ts capacitor.config.ts tsconfig.json vitest.config.ts vitest.generator.config.ts package.json android apps/web/
```
Expected: `renamed: app.vue -> apps/web/app.vue` (etc.) for every path.

> Do **not** move `node_modules`, `.nuxt`, `.output`, or `dist` — they are gitignored build output and will be regenerated under `apps/web`. Leave the stray root files (`AGENTS.md`, `README.md`, `docs/`, `POC Data.xlsx`, `ui*.xml`, `screen*.png`, `tmp_*`, `dev.log`) where they are.

- [ ] **Step 3: Create the new lean root `package.json`**

Write `package.json` at the repo root:
```json
{
  "name": "warehouse-pda",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "dev:web": "pnpm --filter @warehouse/web dev",
    "dev:api": "pnpm --filter @warehouse/api dev",
    "build": "pnpm -r build",
    "generate": "pnpm --filter @warehouse/web generate",
    "test": "pnpm -r test",
    "cap:sync": "pnpm --filter @warehouse/web cap:sync",
    "cap:android": "pnpm --filter @warehouse/web cap:android",
    "cap:android:dev": "pnpm --filter @warehouse/web cap:android:dev"
  }
}
```

- [ ] **Step 4: Update `pnpm-workspace.yaml`**

Replace contents with:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 5: Rename the web package and add the shared dependency**

Make exactly two edits to the moved `apps/web/package.json` and leave everything else (all existing scripts and dependencies, including `postinstall: nuxt prepare`) untouched:

1. Change the name field:
   - from: `"name": "web-demo",`
   - to:   `"name": "@warehouse/web",`
2. Add one line inside the existing `dependencies` object (alphabetical position is fine):
   - `"@warehouse/shared": "workspace:*",`

No other lines change.

- [ ] **Step 6: Ignore SQLite files in `.gitignore`**

Append to `.gitignore`:
```gitignore
# SQLite (apps/api)
*.sqlite
*.sqlite-wal
*.sqlite-shm
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: move frontend into apps/web and set up pnpm workspace root"
```

> Verification of the move happens in Task 5 (`nuxt prepare`). Nothing runs yet because `packages/shared` and `apps/api` do not exist, so the workspace is not installable until Task 4 is complete.

---

## Task 3: Create `packages/shared`

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: `packages/shared/package.json`**

```json
{
  "name": "@warehouse/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "typescript": "^6.0.3"
  }
}
```

- [ ] **Step 2: `packages/shared/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: `packages/shared/src/index.ts`**

```ts
// Shared cross-package types. DTOs from apps/web/services/types.ts will migrate
// here in a later spec when the frontend `api` adapter is implemented.
//
// Consumed via type-only imports (e.g. `import type { HealthResponse } from
// "@warehouse/shared"`), so this package ships its TypeScript source directly
// and requires no build step for consumers in this iteration.

export interface HealthResponse {
  ok: boolean;
  db: "ok" | "error";
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add @warehouse/shared package with HealthResponse type"
```

---

## Task 4: Scaffold `apps/api` package files (no implementation yet)

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/.env.example`
- Create: `apps/api/drizzle/.gitkeep`

- [ ] **Step 1: `apps/api/package.json`**

```json
{
  "name": "@warehouse/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "tsx --test src/**/*.test.ts"
  },
  "dependencies": {
    "@warehouse/shared": "workspace:*"
  }
}
```
> External dependencies (`hono`, `better-sqlite3`, etc.) are added in Task 6 via `pnpm add` so versions resolve from the registry.

- [ ] **Step 2: `apps/api/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: `apps/api/.env.example`**

```dotenv
PORT=3001
DATABASE_URL=./dev.sqlite
CORS_ORIGINS=http://localhost:3000,http://localhost,capacitor://localhost
```

- [ ] **Step 4: `apps/api/drizzle/.gitkeep`**

Create an empty file:
```bash
mkdir -p apps/api/drizzle && touch apps/api/drizzle/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): scaffold @warehouse/api package files"
```

---

## Task 5: Install the workspace and verify the frontend still works

**Files:**
- Modify: `pnpm-lock.yaml` (regenerated by install)

- [ ] **Step 1: Remove stale root build artifacts (recommended, reversible)**

```bash
rm -rf node_modules apps/web/.nuxt apps/web/.output apps/web/dist
```
Expected: directories removed. These are gitignored and regenerated by install/build.

- [ ] **Step 2: Install the workspace**

```bash
pnpm install
```
Expected: pnpm links the three packages. `apps/web`'s `postinstall` runs `nuxt prepare` inside `apps/web`. `node_modules` is created at the root and inside `apps/web`. No errors about missing `@warehouse/*` packages.

- [ ] **Step 3: Verify the frontend type generation still works post-move**

```bash
pnpm --filter @warehouse/web exec nuxt prepare
```
Expected: completes without errors; `apps/web/.nuxt` regenerated. This confirms the `~/...` aliases and `rootDir` resolve correctly from `apps/web`.

- [ ] **Step 4: Commit the lockfile**

```bash
git add pnpm-lock.yaml
git commit -m "chore: install workspace and update lockfile"
```

---

## Task 6: Implement the Hono API with a `/health` route (TDD)

**Files:**
- Modify: `apps/api/package.json` (deps added via `pnpm add`)
- Create: `apps/api/src/db.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/health.test.ts`

- [ ] **Step 1: Add runtime dependencies**

```bash
pnpm --filter @warehouse/api add hono @hono/node-server better-sqlite3 dotenv drizzle-orm@^0.45.0
```
Expected: each added to `apps/api/package.json` `dependencies` with resolved versions.

- [ ] **Step 2: Add dev dependencies**

```bash
pnpm --filter @warehouse/api add -D tsx @types/better-sqlite3 typescript@^6.0.3 @types/node@^26.1.0
```
Expected: each added to `apps/api/package.json` `devDependencies`.

- [ ] **Step 3: Write the failing health test**

Create `apps/api/src/health.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "./index";

test("GET /health returns ok with the database reachable", async () => {
  const res = await app.request("/health");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; db: string };
  assert.equal(body.ok, true);
  assert.equal(body.db, "ok");
});
```

- [ ] **Step 4: Run the test to confirm it fails**

```bash
pnpm --filter @warehouse/api test
```
Expected: FAIL — cannot resolve `./index` (module not found) because `index.ts` does not exist yet.

- [ ] **Step 5: Implement `apps/api/src/db.ts`**

```ts
import "dotenv/config";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const dbPath = path.resolve(process.env.DATABASE_URL ?? "./dev.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Schema is intentionally empty — the database structure will be rethought later.
export const db = drizzle(sqlite, { schema: {} });
```

- [ ] **Step 6: Implement `apps/api/src/routes/health.ts`**

```ts
import { Hono } from "hono";
import type { HealthResponse } from "@warehouse/shared";
import { sqlite } from "../db";

export const healthRoute = new Hono().get("/health", (c) => {
  let db: HealthResponse["db"] = "ok";
  try {
    sqlite.prepare("SELECT 1").get();
  } catch {
    db = "error";
  }

  const body: HealthResponse = { ok: db === "ok", db };
  return c.json(body, db === "ok" ? 200 : 500);
});
```

- [ ] **Step 7: Implement `apps/api/src/index.ts`**

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health";

export const app = new Hono();

const origins = (
  process.env.CORS_ORIGINS ??
  "http://localhost:3000,http://localhost,capacitor://localhost"
).split(",");

app.use("*", cors({ origin: origins }));
app.route("/", healthRoute);
```

- [ ] **Step 8: Implement `apps/api/src/server.ts`**

```ts
import "dotenv/config";
import { serve } from "@hono/node-server";
import { app } from "./index";

const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
```

- [ ] **Step 9: Run the test to confirm it passes**

```bash
pnpm --filter @warehouse/api test
```
Expected: PASS — `GET /health returns ok with the database reachable`.

- [ ] **Step 10: Typecheck/build the API**

```bash
pnpm --filter @warehouse/api build
```
Expected: `tsc` emits `apps/api/dist/` with no type errors (confirms the `@warehouse/shared` type import and `better-sqlite3` types resolve).

- [ ] **Step 11: Boot the API and curl `/health`**

Start the server (background) and request the route:
```bash
pnpm --filter @warehouse/api dev &
sleep 3
curl -s http://localhost:3001/health
```
Expected output: `{"ok":true,"db":"ok"}`

Then stop the background server:
```bash
kill %1
```

- [ ] **Step 12: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): add Hono server with SQLite-backed /health route"
```

---

## Task 7: End-to-end verification

**Files:** none (verification only; commit only if a fix is required).

- [ ] **Step 1: Confirm the workspace graph**

```bash
pnpm -r list --depth -1
```
Expected: lists `@warehouse/api`, `@warehouse/shared`, `@warehouse/web`.

- [ ] **Step 2: Confirm the frontend still boots on PGlite**

```bash
pnpm --filter @warehouse/web dev &
sleep 8
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
kill %1
```
Expected: HTTP `200` from Nuxt. `warehouseAdapter` is still `"pglite"`; no frontend code changed in this plan.

- [ ] **Step 3: Confirm `native-android/` is gone and not tracked**

```bash
test ! -d native-android && echo "removed"
git ls-files native-android | wc -l
```
Expected: `removed` and `0`.

- [ ] **Step 4: Confirm SQLite files are ignored**

```bash
git check-ignore apps/api/dev.sqlite && echo "ignored"
```
Expected: prints the path and `ignored`.

- [ ] **Step 5: Final status**

```bash
git status --short
```
Expected: clean working tree (only `apps/api/dev.sqlite*` may exist and must be ignored/hidden).

---

## Out of scope (explicitly deferred)

- SQLite schema/tables, migrations, and seed data (DB structure to be rethought).
- The ~60 `WarehouseService`/`AuthService` business endpoints (see `docs/superpowers/specs/2026-07-07-api-endpoints-design.md`).
- Implementing `services/adapters/apiWarehouse.ts` / `apiAuth.ts` and switching `warehouseAdapter` to `"api"`.
- Auth/JWT, CORS hardening, pagination, offline support.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `git mv` breaks Nuxt `rootDir`/`~` alias or Capacitor paths | Config and `android/` move together; Nuxt derives `rootDir` from the config location; Task 5 Step 3 (`nuxt prepare`) and Task 7 Step 2 (dev boot) catch breakage before the plan is considered done. |
| `better-sqlite3` native build fails on Windows | pnpm downloads prebuilt binaries for supported Node versions; if it falls back to node-gyp and build tools are missing, install "Desktop development with C++" or use a Node version with a prebuilt binary. |
| `tsx --test` glob expands differently on Windows (Git Bash) | The glob `src/**/*.test.ts` is quoted in `package.json`; if the shell does not expand it, tsx's own glob handling still picks up the file. If the test "cannot find" the file, run `tsx --test src/health.test.ts` directly as a fallback. |
| Root loses app deps during the move (Task 2) before install (Task 5) | No `pnpm`/`nuxt` command runs between the move and install; the workspace becomes installable once Task 4 adds the last `package.json`. |
