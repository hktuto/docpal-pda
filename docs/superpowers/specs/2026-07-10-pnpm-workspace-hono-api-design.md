# pnpm Workspace + Hono API (SQLite) — Workspace Bootstrap

**Date:** 2026-07-10
**Status:** Approved (design). Implementation plan to follow.
**Goal:** Convert the single-app repo into a pnpm monorepo, scaffold a Hono API package backed by SQLite, and remove the unused `native-android/` project. This iteration only stands up the workspace and a health route; the database schema and business endpoints are intentionally deferred.

## Background

The frontend currently runs PGlite (PostgreSQL compiled to WASM) inside the Capacitor WebView. On Android this is too slow for scan-heavy flows, so we are moving toward a real server API.

The codebase is already half-prepared for this pivot:

- `services/warehouse.ts` defines a `WarehouseService` interface (~60 methods) plus a `createWarehouseService` factory that selects an adapter by `runtimeConfig.public.warehouseAdapter` (`"pglite"` | `"api"`).
- `services/auth.ts` defines the analogous `AuthService` with the same adapter switch.
- `services/adapters/pgliteWarehouse.ts` and `services/adapters/pgliteAuth.ts` are fully implemented.
- `services/adapters/apiWarehouse.ts` and `services/adapters/apiAuth.ts` exist but every method throws `not implemented`.
- `nuxt.config.ts` already exposes `runtimeConfig.public.warehouseAdapter` and `runtimeConfig.public.apiBaseUrl`.
- `docs/superpowers/specs/2026-07-07-api-endpoints-design.md` enumerates the HTTP contract that maps each service method to an endpoint. It remains the roadmap for the business endpoints and is **not** re-scoped here.
- `pnpm-workspace.yaml` exists but is a placeholder (`packages: ['.']`); `.gitignore` already references `apps/*/dist`, signalling `apps/*` as the intended layout.
- `native-android/` is a separate standalone Kotlin/Room project (package `com.docpal.warehouse`, 58 tracked source files, ~800 MB of untracked Gradle output). It is unrelated to the Capacitor `android/` shell we keep and is now obsolete.

## Scope of this iteration

In scope:

1. pnpm workspace with three packages: `apps/web`, `apps/api`, `packages/shared`.
2. Move the existing Nuxt app into `apps/web` with no behavior change (still on PGlite, `warehouseAdapter: "pglite"`).
3. New `apps/api` Hono server with a `GET /health` route and a minimal, schema-less SQLite connection.
4. New `packages/shared` with a small real export (API base-path constant + `HealthResponse` type).
5. Remove `native-android/`.

Out of scope (deferred to later specs):

- SQLite schema/tables and seed data (the DB structure will be rethought).
- All `WarehouseService`/`AuthService` business endpoints.
- Implementing the frontend `apiWarehouse`/`apiAuth` adapters.
- Switching `warehouseAdapter` to `"api"`.
- Auth/JWT, CORS hardening, pagination, offline support.

## Workspace layout

```
warehouse-pda/
  pnpm-workspace.yaml          packages: ["apps/*", "packages/*"]
  package.json                 lean root: private + workspace scripts only
  AGENTS.md, README.md, docs/  stay at root
  apps/
    web/                       entire existing Nuxt app (incl. android/, capacitor.config.ts)
    api/                       new Hono app
  packages/
    shared/                    API base-path constant + shared types (minimal now)
```

- Package names are scoped: `@warehouse/web`, `@warehouse/api`, `@warehouse/shared`.
- Cross-package dependency: `@warehouse/web` and `@warehouse/api` both depend on `@warehouse/shared` via `"workspace:*"`.
- The frontend is moved with `git mv` to preserve history. Nuxt derives `rootDir` from the config file location, so existing `~/...` imports continue to resolve against `apps/web`.
- The Capacitor `android/` directory moves into `apps/web/android` so `cap sync` keeps resolving relative to `capacitor.config.ts`.

### Root `package.json`

- `private: true`, `type: module`.
- No app dependencies at root (they move into `apps/web`).
- Scripts are thin delegates:
  - `dev`: `pnpm -r --parallel dev`
  - `dev:web`: `pnpm --filter @warehouse/web dev`
  - `dev:api`: `pnpm --filter @warehouse/api dev`
  - `build`: `pnpm -r build`
  - `generate`: `pnpm --filter @warehouse/web generate`
  - `test`: `pnpm -r test`
  - `cap:sync`, `cap:android`, `cap:android:dev`: delegate to `@warehouse/web`.

### `apps/web`

- `name: "@warehouse/web"`. Adds `"@warehouse/shared": "workspace:*"`.
- All current scripts, deps, and config move here unchanged.
- `warehouseAdapter` remains `"pglite"`; the `api` adapter remains a stub. No user-facing change.

## `apps/api`

**Stack (Node runtime, matching the existing toolchain):**

- `hono`, `@hono/node-server`
- `better-sqlite3` (SQLite driver) + `drizzle-orm` (sqlite handle, empty schema)
- `@hono/cors`, `dotenv`
- Dev: `tsx watch`. Build: `tsc` to `dist/`, run via `node dist/server.js`.

**Files:**

- `src/server.ts` — reads `PORT`/`DATABASE_URL`, starts `@hono/node-server`.
- `src/index.ts` — creates the Hono app, mounts CORS and routes.
- `src/db.ts` — opens the SQLite file, sets `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`, exports a raw `sqlite` handle and a Drizzle `db` handle created from an **empty schema object**.
- `src/routes/health.ts` — `GET /health`.
- `drizzle/` — empty directory reserved for future migrations.
- `.env.example` — `PORT=3001`, `DATABASE_URL=./dev.sqlite`. `DATABASE_URL` is a filesystem path passed straight to `new Database(path)` (no `file:` prefix).

**Health route:**

- `GET /health` → `200 { ok: true, db: "ok" }` after executing `SELECT 1` against SQLite via the raw handle. This proves the server boots and SQLite is reachable without defining any tables.
- `/api/v1/*` is reserved for future routes but no routes are mounted there yet.

**Config & CORS:**

- Default port `3001` (web stays on `3000`).
- CORS allows the dev web origin (`http://localhost:3000`) and Capacitor origins (`http://localhost`, `capacitor://localhost`) so the frontend can call the API later without further server changes.

**No schema, seed, or migrations yet.** Drizzle is wired so the ORM choice is preserved, but the schema object is empty pending the DB rethink.

## `packages/shared`

Minimal but non-empty so the package is real:

- `src/index.ts` exports `API_BASE_PATH = "/api/v1"` and a `HealthResponse` type (`{ ok: boolean; db: "ok" | "error" }`) used by the health route.
- The frontend `services/types.ts` stays in `apps/web` for now; DTOs migrate here in a later spec when the `api` adapter is implemented.

## `native-android/` removal

- `git rm -r native-android` for the 58 tracked files, then remove the remaining untracked Gradle build output.
- This was explicitly authorized by the user.
- The Capacitor `android/` shell (moved into `apps/web/android`) is unaffected.

## `.gitignore` updates

- Ignore SQLite files: `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`.
- `apps/*/dist` is already present; keep it.

## Verification (this iteration)

- `pnpm install` resolves the workspace and all three packages.
- `pnpm --filter @warehouse/api dev` boots on `:3001`; `curl http://localhost:3001/health` returns `{ ok: true, db: "ok" }`.
- `pnpm --filter @warehouse/web dev` still boots on `:3000` with the PGlite path unchanged.
- `pnpm --filter @warehouse/web exec nuxt prepare` generates types without errors.
- `native-android/` is gone from the working tree and from git tracking.

## Risks

| Risk | Mitigation |
|---|---|
| `git mv` of the whole frontend breaks Nuxt `rootDir`, the `~` alias, or Capacitor paths | Move config and `android/` together; rely on Nuxt deriving `rootDir` from the config location; verify with `nuxt prepare` + a dev boot before claiming done. |
| Root vs. package script/dependency drift | Keep all app deps inside `apps/web`; root stays lean; root scripts only delegate. |
| Committing to a SQLite engine that the later DB rethink might change | Only the connection and a health ping are written now; no schema, so switching drivers later is cheap. |
| Removing `native-android/` deletes something still referenced | It is a standalone Gradle project with no references from the Nuxt app; confirm via search before removal. |
