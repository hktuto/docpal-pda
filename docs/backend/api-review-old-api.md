# Old API (`apps/api`) Design Review

Review of all 12 route files / ~45 endpoints in `apps/api/src/routes/`
(2026-07-17). Verdicts: **good** (carry over), **mixed** (right granularity,
wrong shape), **bad** (redesign).

## Per-flow verdicts

### Receiving (`receiving.ts`)
| Endpoint | Verdict | Note |
|---|---|---|
| `GET /receiving-orders?status=` | good | Right granularity; aggregate counts; no N+1 |
| `GET /receiving-orders/:id` | good | Properly nested (order→invoices→items→part+mismatch) |
| `GET /receiving-orders/:id/picking` | mixed | Good separation, bad shape: flat rows + keyed maps the client joins; logs keyed by picking-**order** but client needs picking-**item** |
| `POST /picking-items/transition-logs` | bad | Read-via-POST, wrong router, exists only to patch the wrong-keyed logs |
| `GET /receiving-orders/:id/scan-candidates` | mixed | Server mirrors the client's internal view model; lazy-loaded at scan time is fine |
| `PUT /receiving-orders/:external_id` | good | Idempotent ingest upsert keyed by external id — right shape |
| `POST .../confirm-arrival` | mixed | Ambiguous `id` vs `external_id` namespace; no actor recorded |

### Mismatch (`mismatch.ts`)
Best-designed file (item-keyed, clean PATCH semantics) — but the web adapter
never followed the redesign: **4 of 5 client calls 404**. Design good, drift
fatal. `/cancel` could be `DELETE`.

### Ingest (`ingest/`)
PUT-by-external-id upsert shape is right. Internals (not API design) smell:
HTTP exceptions in domain code, O(n²) reconcile, per-line N+1, fire-and-forget
post-commit allocation.

### Picking (`picking.ts`, `pickingExecution.ts`)
| Endpoint | Verdict | Note |
|---|---|---|
| `PUT /picking-orders/:external_id` | good | Ingest upsert |
| `GET /picking-orders` | good | List with counts |
| `GET /picking-orders/:id` | mixed | Flat parallel arrays force client joins; N+1 per allocation |
| `POST /picking-orders/report-issues` | mixed | Batch but under-expressive: client joins per-order remarks with `"; "` |
| `POST /picking-orders/:id/ocr-pick` | bad | Path lies: `:id` is a *receiving* order id |
| 6 nested mutation twins | bad | No caller; kept alongside the flat routes actually used |
| `DELETE /packages/:id` | bad | Polymorphic: silently unboxes OR deletes |
| Weight fields | bad | `net_weight` vs `net_weight_g` inconsistency between routes |

### Measuring / boxes (`measuring.ts`, `boxes.ts`)
Three endpoints answer "order + boxes + packages" differently
(`/picking-orders/:id`, `/measuring-tasks/:id`, `/shipping-boxes/:id/for-measuring`),
all incomplete (`for-measuring` lacks `part_id` → second request + client-side
scan matching). `PATCH /shipping-boxes/:id` is the model citizen. Two dead
routes (`verify`, `verify-package`). Measuring detail reads columns that no
longer exist (bug).

### Put-away (`putAway.ts`)
Verbs everywhere (`assign-to-box`, `remove-piece`, `add-all-unboxed`), three
path prefixes in one file, actor passed three ways (body / query / none), one
detail screen needs 3 sequential GETs, `POST /put-away/scans` needs a fix-up
query because its response is incomplete.

### Goods verify (`goodsVerify.ts`)
`/shelves` vs `/shelves/with-box-counts` duplicate resource; fake `zone: null`
shipped over the wire; items have no ids (client synthesizes them); **no
mark-box-verified endpoint** — client hacks it via `/verification-tasks`.

### Stock search (`stockSearch.ts`)
Acceptable read-model shape, but one screen = 3 sequential calls; CSV query
param; `location_label` is presentation logic on the server.

### Auth / health / dev
`health`, `dev/reset` fine. Auth works but camelCase against the snake_case
everywhere else, plus a real contract bug (`name` vs `displayName` →
`displayName` undefined in api mode). No session/token (demo).

## Cross-cutting problems

1. **Case split** — snake_case SQL passthrough vs camelCase auth; every read
   remapped in the adapter.
2. **Verb-RPC mutations** — `/close`, `/finish`, `/complete`, `/cancel`,
   `/verify`, `/scan` in paths with no uniform convention.
3. **Client-join read models** — flat arrays + keyed maps push joins to the
   client; several screens pay 2–3 round trips for it.
4. **Dead/duplicate routes** — ~10 endpoints with no caller or a preferred twin.
5. **Actor passing** — body field vs query param vs missing; no convention.
6. **Actual bugs** — mismatch adapter drift (4 broken calls), auth
   `displayName`, measuring stale columns.

## Bottom line

Read granularity is mostly fine (list + status filter, detail / detail-picking
split are good and endorsed). What's broken: response shapes (client-side
joins), verb-RPC writes, dead routes, and client/server drift. ~70% of the
read structure carries over; the write surface and bundle shapes get
redesigned. See `api-design.md`.
