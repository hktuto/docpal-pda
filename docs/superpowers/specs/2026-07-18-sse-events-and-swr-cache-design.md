# SSE Server Events + Web SWR Cache — Design

Date: 2026-07-18
Status: agreed (user approved SSE + localStorage cache invalidated by SSE)

## Problem

1. Users get no push feedback when server-side work completes: allocation
   recalculation after a receiving order is confirmed, day-end goods-verify
   task generation, new picking orders arriving via ingest. They must manually
   revisit pages to discover new work.
2. Every page does a blocking HTTP fetch on mount and on every
   visibility/focus event (`useVisibleReload`). Against the hosted backend
   (Vercel + Neon) this makes navigation feel slow, even when nothing changed.

## Decisions

### Transport: SSE, not WebSocket

- The backend deploys to Vercel serverless, which does not support WebSocket.
  SSE is a plain streamed HTTP response and works there (and on the pm2/local
  `@hono/node-server` deployments).
- Vercel caps function duration (`maxDuration: 60`). The server closes the
  stream at ~55 s and the client reconnects with its last-seen event id.
  Browser-native `EventSource` auto-reconnect reuses the same URL and relies
  on the `Last-Event-ID` header, whose CORS behavior is inconsistent in WebViews
  — so the client runs a **manual reconnect loop** and passes the cursor as an
  explicit `?since=<id>` query param instead.

### Delivery: transactional outbox, not LISTEN/NOTIFY or in-memory pub/sub

- Serverless means the mutation that creates an event runs in a different
  function instance than the one holding a user's SSE stream; in-memory
  fan-out silently loses events.
- Neon's pooler (PgBouncer transaction mode) does not support
  `LISTEN/NOTIFY`.
- So: mutations insert a row into an `app_events` table **inside the same
  transaction** as the domain change (same pattern as `transaction_logs`).
  The SSE endpoint polls the table (`WHERE id > $1 ORDER BY id LIMIT 200`)
  every ~1.5 s and streams new rows. Every connected stream reads the DB
  independently, so fan-out works on any number of instances, events are
  durable, and reconnecting clients catch up via `?since=`.

### Cache: client-side SWR with SSE-driven invalidation, no backend cache

- All GET responses are cached in memory + localStorage with a short TTL
  (60 s) as a correctness floor.
- SSE events carry `topics` (URL path prefixes, e.g. `/picking-orders`).
  A matching event deletes matching cache entries immediately and tells
  mounted pages to reload — so with the stream connected, data is at worst
  ~2 s stale; disconnected, at worst 60 s.
- Local mutations (POST/PATCH/DELETE through `apiClient`) invalidate their own
  first-path-segment prefix plus related read models from a small
  `MUTATION_INVALIDATIONS` map (e.g. `/picking-items` scans also invalidate
  `/picking-orders`), so detail pages stay cached safely.
- No backend response cache: on serverless it is per-instance, saves a DB
  query but not the roundtrip, and adds invalidation complexity. Revisit
  only if profiling says otherwise (the outbox would make ETags cheap).

### Scope of notifications

Toast notifications (via the existing `useToast`/`ToastHost`) only for
semantic "new work" events; cache invalidation happens for all events.

## Event catalog (initial)

| type | emitted from | topics | toast |
|---|---|---|---|
| `allocation.computed` | `allocateAll` (inside its tx, when allocations created/removed > 0) | `/picking-orders` | yes → /picking |
| `picking_order.created` | `upsertPickingOrder` when `created` | `/picking-orders` | yes → /picking |
| `picking_order.updated` | `upsertPickingOrder` when `changed` (not created) | `/picking-orders` | no |
| `goods_verify.tasks_created` | `generateGoodsVerifyTasks` when count > 0 | `/goods-verify-tasks` | yes → /goods-verify |
| `receiving_order.upserted` | `upsertReceivingOrder` when created/changed | `/receiving-orders` | no |

Payload: `{ id, type, topics, data, createdAt }` — `data` is free-form JSONB
(e.g. order id, ref_no, task count) for toast text and future use.

Adding a new event type = one `emitEvent(...)` call inside an existing tx.

## Backend design

- New table `app_events`:
  - `id bigserial primary key` (monotonic cursor — first non-text id in the
    schema, justified: SSE resume needs cheap, gap-tolerant ordering),
    `mode: "number"` in Drizzle (safe below 2^53).
  - `type text not null`
  - `topics text[] not null` (URL path prefixes used for cache invalidation)
  - `data jsonb not null default '{}'`
  - `created_at timestamp not null`
  - index on `(id)` implicit via PK; pruning keeps the table small.
- New module `src/db/events.ts`:
  - `emitEvent(dbOrTx, { type, topics, data? })` — modeled on the per-module
    `logTransition` helpers (e.g. `src/db/goodsverify.ts:40-61`).
  - `fetchEventsSince(db, since, limit)` — the poller query.
  - `pruneEvents(db)` — deletes rows older than 3 days; called on server boot
    (non-Vercel) and fire-and-forget on new SSE connections.
- Emission points (all inside the existing txs, except as noted):
  - `src/db/allocate.ts` `allocateAll` — inside its own `db.transaction`, when
    `allocationsCreated + allocationsRemoved > 0`. One change covers all 7
    route call sites.
  - `src/db/ingest.ts` `upsertPickingOrder` / `upsertReceivingOrder` — inside
    the upsert tx, keyed off the existing `created`/`changed` result flags.
  - `src/db/goodsverify.ts` `generateGoodsVerifyTasks` — currently a single
    raw-SQL INSERT (no tx); emit after the insert with the number of created
    rows (add `RETURNING id` / count).
- New route `src/routes/events.ts`: `GET /events?since=<id>`
  - `streamSSE` from `hono/streaming` (hono 4.12.29 has it).
  - Cursor = `?since` param, falling back to `Last-Event-ID` header.
  - On connect: send backlog since cursor (cap 500), then poll every 1.5 s.
  - Heartbeat SSE comment every 25 s (keeps proxies from idling out).
  - Each event: `id: <id>`, `event: <type>`, `data: <json>`.
  - On Vercel (`process.env.VERCEL`): close the stream after ~55 s so the
    client reconnects cleanly before `maxDuration`.
  - Unauthenticated (consistent with the rest of the POC API).
- CORS (`src/index.ts`): add `allowHeaders: ["Content-Type", "Last-Event-ID"]`
  for safety; `GET /events` is otherwise already covered.
- Migration via `pnpm --filter @warehouse/backend db:generate` (→ `0013_*`);
  hosted Neon DB migrated manually with `DATABASE_URL=<unpooled> pnpm
  --filter @warehouse/backend db:migrate` (same procedure as before).

## Web design

- New `services/apiCache.ts` (plain module, no Vue deps):
  - `getCached(url): entry | null`, `setCached(url, data)`,
    `invalidatePrefix(prefix)`, `clearApiCache()`.
  - In-memory `Map` mirrored to localStorage under `wms-cache:<url>` so app
    restarts serve instantly; entries are `{ ts, data }`.
  - TTL 60 s. Eviction: cap ~150 entries, evict oldest `ts`.
- `services/apiClient.ts`: `get(path, params?, opts?: { cache?: boolean })`
  — default cache on; check `getCached` first, on fetch success `setCached`.
  Successful `post/patch/del` → `invalidatePrefix("/" + firstSegment)`.
- New `composables/useWarehouseEvents.ts` (module-level singleton, same
  pattern as `useToast`):
  - `state`: `connected`, `lastEventId` (persisted `wms-events-last-id`).
  - `connect()`: `new EventSource(`${apiBaseUrl}/events?since=${lastId}`)`;
    on each message: persist `event.lastEventId`, call
    `invalidatePrefix` for each topic, notify topic subscribers, show toast
    for toastable types.
  - Manual reconnect: `onerror` → close, retry with backoff (2 s → max 30 s)
    using the persisted `since` cursor. Never relies on `Last-Event-ID`.
  - `subscribe(topics, cb)` / unsubscribe for pages.
  - Lifecycle: watch `currentUser` from `useAuth` — connect when logged in,
    `disconnect()` + `clearApiCache()` on logout. Started from
    `layouts/default.vue` (or `app.vue`).
- `useVisibleReload(load, topics?)`: optional `topics` arg subscribes the
  mounted page to matching events → `load()`. Existing calls keep working;
  high-traffic list pages (receiving, picking, goods-verify) get topics.
- Toasts: existing `showToast(message, { action: { label, to } })`; new
  locale keys in `i18n/locales/*` (en-US, zh-CN, zh-HK).
- `AppHeader.resetDb` already does `localStorage.clear()` — no change needed.

## Known limits (accepted for the POC)

- SSE only notifies while the app is open. Background/lock-screen push would
  need FCM — out of scope.
- Vercel: each 55 s reconnect is a new function invocation; at POC usage the
  1.5 s polling load is trivial. The pm2/local node server holds streams
  indefinitely.
- The cache is per-device; another user's changes arrive via SSE (~2 s) or
  TTL (60 s worst case if the stream is down).
- Events are best-effort notifications, not a command log — no replay UI, no
  per-user read state.

## Verification

- Backend node:test: `src/db/events.test.ts` — emitEvent writes a row inside
  a tx (and rolls back with it); allocateAll emits exactly one
  `allocation.computed` when allocations change and none when idempotent;
  ingest upserts emit created/updated correctly; goods-verify generate emits
  with count. Existing suites must stay green.
- Web vitest: `tests/apiCache.test.ts` (TTL, prefix invalidation, eviction,
  localStorage mock) and `tests/useWarehouseEvents.test.ts` (mock EventSource:
  reconnect with since cursor, topic fan-out, toast mapping).
- Manual: two browser sessions against local backend; confirm-arrival in one
  → toast + list refresh in the other within ~2 s; repeat against the Vercel
  deployment including a >60 s idle reconnect.
