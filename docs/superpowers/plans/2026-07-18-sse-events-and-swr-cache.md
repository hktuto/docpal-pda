# SSE Server Events + Web SWR Cache — Implementation Plan

Date: 2026-07-18
Spec: `docs/superpowers/specs/2026-07-18-sse-events-and-swr-cache-design.md`

Three independently shippable steps: (1) backend outbox + SSE, (2) web event
bus + toasts, (3) SWR cache + invalidation. Steps 1–2 alone deliver the
notifications; step 3 delivers the speedup.

## Step 1 — Backend: `app_events` outbox + emission + `GET /events`

### 1.1 Schema + migration

- New `apps/backend/src/db/schema/events.ts` (style per `schema/audit.ts`):
  ```ts
  export const appEvents = pgTable("app_events", {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    topics: text("topics").array().notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  });
  ```
- Add `export * from "./events.js";` to `src/db/schema/index.ts`.
- `pnpm --filter @warehouse/backend db:generate` → `drizzle/0013_*.sql`.
  Sanity-check the generated SQL (bigserial PK, text[] not null, jsonb default).

### 1.2 `src/db/events.ts` helper module

- `emitEvent(dbOrTx: DbOrTx, e: { type: string; topics: string[]; data?: Record<string, unknown> })`
  — `insert(appEvents).values(...)`; mirror the `logTransition` shape in
  `src/db/goodsverify.ts:40-61` (uses `DbOrTx` from `src/db/query.ts`).
- `fetchEventsSince(db: AppDb, since: number, limit = 200)` —
  `select().from(appEvents).where(gt(appEvents.id, since)).orderBy(appEvents.id).limit(limit)`.
- `pruneEvents(db: AppDb)` — `delete().where(lt(appEvents.createdAt, sql`now() - interval '3 days'`))`.

### 1.3 Emission points

- `src/db/allocate.ts` `allocateAll` (`:171`): inside its existing
  `db.transaction`, after computing the summary, when
  `summary.allocationsCreated + summary.allocationsRemoved > 0` →
  `emitEvent(tx, { type: "allocation.computed", topics: ["/picking-orders"], data: summary })`.
- `src/db/ingest.ts`:
  - `upsertPickingOrder` (`:576`): when result `created` →
    `picking_order.created`; else when `changed` → `picking_order.updated`;
    topics `["/picking-orders"]`, data `{ id, refNo, externalId }`.
  - `upsertReceivingOrder` (`:313`): when `created || changed` →
    `receiving_order.upserted`, topics `["/receiving-orders"]`.
  - Emit inside the existing upsert transactions so rollbacks drop events.
- `src/db/goodsverify.ts` `generateGoodsVerifyTasks` (`:77-104`): add
  `RETURNING id` (or a count) to the raw INSERT; when > 0 rows →
  `emitEvent(db, { type: "goods_verify.tasks_created", topics: ["/goods-verify-tasks"], data: { date, count } })`
  (single statement, no tx today — emit right after).

### 1.4 SSE route `src/routes/events.ts`

- `GET /events`:
  - cursor: `Number(c.req.query("since") ?? c.req.header("last-event-id") ?? 0)`.
  - fire-and-forget `pruneEvents(db)`.
  - `streamSSE(c, async (stream) => { ... })`:
    - `let cursor`; loop: `fetchEventsSince(db, cursor)` → write each as
      `{ event: row.type, data: JSON.stringify({...}), id: String(row.id) }`,
      advance cursor; `stream.sleep(1500)`; heartbeat `: ping\n\n` every 25 s.
    - abort on `stream.aborted` / `c.req.raw.signal`.
    - if `process.env.VERCEL`, `setTimeout(() => stream.close(), 55_000)`.
- Mount in `src/index.ts` next to the other `app.route("/", ...)` lines.
- CORS in `src/index.ts:18-23`: add `allowHeaders: ["Content-Type", "Last-Event-ID"]`.
- `src/server.ts`: after `serve(...)`, fire-and-forget `pruneEvents(db)` once
  at boot (local/pm2 only).

### 1.5 Tests — `src/db/events.test.ts`

- `setupTestDb()`/`reseed` per `allocate.test.ts:1-11`.
- emitEvent inside a rolled-back tx leaves no row; committed tx leaves one.
- allocateAll: first run emits one `allocation.computed`; immediate second
  run (idempotent) emits none.
- ingest: first PUT emits `*.created`, repeat PUT unchanged emits nothing,
  changed payload emits `*.updated`.
- goods-verify generate emits with `count > 0` on a seeded day.
- Run: `pnpm --filter @warehouse/backend test` (75 existing + new, all green)
  and `pnpm --filter @warehouse/backend build` (tsc).

### 1.6 Manual check

- `pnpm dev:backend`, then `curl -N "http://localhost:3002/events?since=0"`,
  in another shell `curl -X POST localhost:3002/dev/allocate` → event line
  appears; heartbeat comments arrive.

## Step 2 — Web: event bus + toasts

### 2.1 `apps/web/composables/useWarehouseEvents.ts`

- Module-level state (pattern of `composables/useToast.ts`):
  `connected` ref, `lastEventId` (localStorage `wms-events-last-id`),
  subscriber list `{ topics: string[], cb }`, `es: EventSource | null`,
  backoff delay (2 s, ×1.5 up to 30 s).
- `connect()`: reads `useRuntimeConfig().public.apiBaseUrl` (as
  `composables/useWarehouse.ts:4-8` does); opens
  `EventSource(`${base}/events?since=${lastEventId}`)`;
  registers `es.addEventListener(type, handler)` for each known type from the
  spec catalog (unknown types ignored).
- Handler: persist `lastEventId = event.lastEventId`; parse data;
  for each topic → `invalidatePrefix(topic)` (wired in step 3; behind a
  dynamic import or a registered hook so step 2 ships without step 3 —
  simplest: `useWarehouseEvents` exposes `onInvalidate(cb)` registration that
  `apiCache` wiring fills in step 3); notify matching subscribers; if the
  type is toastable → `useToast().showToast($t(key, data), { action: { label: $t("view"), to } })`.
- `onerror`: `es.close()`, `connected = false`, `setTimeout(connect, backoff)`
  with the persisted cursor.
- `disconnect()`: close, clear timer, `connected = false`.

### 2.2 Lifecycle wiring

- In `layouts/default.vue` setup: watch `useAuth().currentUser` —
  truthy → `connect()`, falsy → `disconnect()`. (Login page has no user → no
  stream; `middleware/auth.global.ts` already gates routes.)
- `AppHeader.vue` `logout()` (`:112-115`): also `disconnect()` and (step 3)
  `clearApiCache()`.

### 2.3 `useVisibleReload(load, topics?)`

- Optional second arg: on mount, `subscribe(topics, load)`; on unmount,
  unsubscribe. Existing callers untouched.
- Add topics to the main list pages: receiving (`["/receiving-orders"]`),
  picking (`["/picking-orders"]`), goods-verify (`["/goods-verify-tasks"]`).

### 2.4 Locale keys (`i18n/locales/en-US.json`, `zh-CN.json`, `zh-HK.json`)

- `event_allocation_computed`, `event_picking_order_created`,
  `event_goods_verify_tasks_created`, plus a `view` action label.

### 2.5 Tests — `tests/useWarehouseEvents.test.ts`

- Mock `EventSource` class; assert: connects with `?since=` from storage;
  message persists cursor + notifies topic subscribers; error closes and
  reconnects with the updated cursor; toast types call showToast.
- `pnpm --filter @warehouse/web test`.

### 2.6 Manual check

- Two browser windows on `:3000`; confirm-arrival in one → toast +
  list refresh in the other within ~2 s.

## Step 3 — Web: SWR cache in `apiClient`

### 3.1 `apps/web/services/apiCache.ts`

- Plain module: `const TTL_MS = 60_000`, in-memory `Map<string, { ts, data }>`,
  localStorage mirror `wms-cache:<url>`.
- `getCached(url)`: memory → localStorage; return `null` when missing or
  `Date.now() - ts > TTL_MS` (expired entries are deleted lazily).
- `setCached(url, data)`; evict oldest when > 150 entries.
- `invalidatePrefix(prefix)`: delete entries whose URL path
  starts with `prefix` (parse with `new URL(url, "http://x")`).
- `clearApiCache()`: drop memory + all `wms-cache:` keys.
- Register `invalidatePrefix` with the event bus hook from step 2.1 (do the
  registration inside `useWarehouseEvents` by importing `apiCache` directly —
  no cycle: apiCache has no imports back).

### 3.2 `services/apiClient.ts`

- `get(path, params?, opts?: { cache?: boolean })` — cache on by default:
  build full URL (same `URLSearchParams` logic, `:59-72`), `getCached` →
  return hit; else fetch, `setCached` on success.
- `post/patch/del`: on success `invalidatePrefix("/" + path.split("/")[1])`.
- No changes needed in `backendWarehouse.ts` (all GETs go through `client.get`);
  pass `{ cache: false }` only if a specific call proves freshness-critical.

### 3.3 Logout/reset hygiene

- `AppHeader.logout` → `clearApiCache()` (with the step-2 `disconnect()`).
- `resetDb` already `localStorage.clear()`s — confirm cache keys are wiped.

### 3.4 Tests — `tests/apiCache.test.ts`

- Mock `localStorage` (node env — follow the mocking pattern in
  `services/adapters/apiAuth.test.ts`): hit/miss/expiry, prefix invalidation
  (with query strings), eviction cap, `clearApiCache`.
- Extend `services/apiClient.test.ts`: GET served from cache on 2nd call,
  POST invalidates its prefix.
- `pnpm --filter @warehouse/web test` (132 existing + new green) and
  `pnpm --filter @warehouse/web nuxt prepare`.

### 3.5 Manual check

- Navigate picking → receiving → picking: instant render from cache; watch
  Network tab — no repeat GET within TTL; confirm-arrival in another window →
  visible list refetches (SSE invalidation), not stale.

## Step 4 — Docs + deploy

- `docs/backend/README.md`: `GET /events` (cursor semantics, 55 s close on
  Vercel, heartbeat), `app_events` table, event catalog.
- `AGENTS.md`: one line under backend routes (events/SSE + outbox) and one
  under web data-access (apiClient cache + `useWarehouseEvents`).
- `docs/app-docs/ai/feature-registry.md`: register the feature files.
- Local: restart `pnpm dev:backend` (boot auto-migrates 0013).
- Hosted: `DATABASE_URL=<neon-unpooled> pnpm --filter @warehouse/backend
  db:migrate`, commit + push → Vercel auto-deploys; verify with
  `curl -N "https://docpal-pda-backend.vercel.app/events?since=0"` and a
  `POST /dev/allocate`... (dev routes are on) — event must appear; keep the
  stream open > 60 s to observe the clean 55 s close.
- Full gates: backend test + build, web test + `nuxt prepare`.

## Out of scope (noted in spec)

- FCM/native push for closed-app notifications.
- Backend response caching / ETags.
- Per-user event read state or notification center UI.
