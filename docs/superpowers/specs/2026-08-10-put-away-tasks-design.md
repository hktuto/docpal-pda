# Put-away tasks + directed put-away design

Date: 2026-08-10
Status: implemented
Builds on: `2026-08-10-flow-config-design.md` (FLOW_CONFIG),
`2026-07-28-verify-step-and-flow-step-config-design.md` (task pattern)

## Problem

With `steps.picking.allocation.allowDockStock=false` (put-away as a hard gate
for picking allocation), put-away stops being an optional tidy-up and becomes
the work queue that picking waits on. The current put-away "list" is a derived
query (`GET /put-away/candidates` — receiving orders with remaining unboxed
qty): no task entity, no status, nothing to hang a shelf suggestion on. We
need:

1. **Real put-away tasks**, auto-created when a receiving order arrives, so
   the operator works from a task queue instead of drilling into receiving
   orders.
2. **Directed put-away**: each task line suggests *where* the item should go
   (shelf), computed by the backend.

## Config

`FLOW_CONFIG` gains two keys under `steps.put-away`:

```json
{
  "steps": {
    "put-away": {
      "enabled": true,
      "autoCreateTasks": false,
      "suggestShelf": "existing-stock"
    }
  }
}
```

- `autoCreateTasks` (bool, default `false`) — when true, confirming a
  receiving arrival creates a `put_away_tasks` row in the same transaction.
  `false` = current behavior (derived candidates list, no task rows).
- `suggestShelf` (`"existing-stock"` | `"off"`, default `"existing-stock"`) —
  per-item shelf suggestion strategy in task responses. Computed at read
  time, advisory only, never stored. `"existing-stock"`: the shelf of the
  most recent `inventory_lots` row for the same `part_no` in the task's
  `org_id + sub_inventory_code`; `null` when the part has no stock history
  (operator chooses, current behavior). Future strategies (fixed slots via
  part master data, zones, capacity) add new enum values, not new keys.

Validation (fail fast at boot, same as the existing FLOW_CONFIG rules):
`autoCreateTasks` must be boolean; `suggestShelf` must be one of the enum
values; both keys are only valid on `put-away`. `enabled: false` +
`autoCreateTasks: true` → startup warning, tasks not created. No new
interaction with the existing deadlock rule (`put-away` off +
`allowDockStock` off stays rejected).

`GET /config` exposes the resolved put-away section as
`putAway: { autoCreateTasks, suggestShelf }` alongside `flowSteps` and
`pickingAllocation`, so the PDA can pick its list source once per login.

## Schema

New table, deliberately mirroring `measuring_tasks`:

```
put_away_tasks
  id                  text PK (UUID v7)
  receiving_order_id  text NOT NULL → receiving_orders(id) ON DELETE CASCADE
  org_id              integer        -- denormalized pair copy from the order
  sub_inventory_code  text           -- (query convenience for the suggestion)
  status              text NOT NULL DEFAULT 'pending'   -- pending | completed
  created_date, last_update_date
  UNIQUE (receiving_order_id)
```

One task per receiving order (mirrors one measuring task per picking order):
operators put away a truck, not a line. No assignee/work-lock columns in v1 —
measuring/verify have none either; add only if multi-operator contention
shows up in practice.

## Lifecycle

- **Create** — inside `confirmReceivingArrival`'s transaction
  (`src/db/receiving.ts`), gated on `autoCreateTasks`: after the order flips
  to `in_hand`, insert the `pending` task (idempotent via the unique index;
  `ON CONFLICT DO NOTHING` so a re-confirm after `provisional_received` is
  safe). Same-tx creation means a task can never be lost if the backend dies
  mid-request — the measuring-task pattern.
- **Complete** — inside `tryMarkReceivingOrderClear` (`src/db/putaway.ts`):
  when the order's remaining-to-put-away hits zero and it transitions
  `in_hand → clear`, the task (if one exists) flips to `completed` in the
  same tx, plus a transition log. Note the auto-clear check itself only runs
  from put-away mutations (pre-existing behavior): an order consumed purely
  by dock picking (`allowDockStock=true`) never triggers it, so its order and
  task stay `in_hand`/`pending` — consistent, and unchanged by this feature.
- **No manual complete/cancel endpoint in v1** — completion is derived from
  the stock counters, like the candidates list already computes; a "complete"
  button would just lie about stock still on the dock.

## API

- `GET /put-away-tasks?status=` — list: task id, status, receiving order
  (batchNo, supplierCode/Name, org/sub-inventory), item counts (`receivedItems`,
  `unboxedItems` — the same remaining formula as `listPutAwayCandidates`),
  `createdDate`. Ordered `created_date ASC` (oldest truck first — the queue).
- `GET /put-away-tasks/:id` — detail: task + receiving order + per-item rows
  (the existing `getReceivingPutAway` aggregate: received/put-away/remaining
  per item, lots, scans, boxes) **plus `suggestedShelfCode` per item** when
  `suggestShelf` is not `"off"`.
- `GET /put-away/candidates` stays unchanged — it remains the list source for
  manual mode and for orders that predate task creation.

The PDA put-away home page switches source on the resolved config:
`autoCreateTasks` on → task list; off → candidates (current page). The task
detail reuses the existing per-order put-away view, with the suggested shelf
rendered as a hint chip per item row.

Admin console: out of scope for v1 (read visibility can ride the existing
receiving detail page later if ops asks).

## Events / ledger

Follow the measuring pattern: creation and completion write
`transaction_logs` rows (`entity_type 'put_away_task'`) inside their txs and
emit `put_away_task.created` / `put_away_task.completed` on the `app_events`
outbox (topic `/put-away-tasks`) so SSE-driven list reloads work
(`useVisibleReload(["/put-away-tasks"])`).

## Suggestion query (existing-stock)

Per item, at task-detail read time:

```sql
SELECT shelf_code FROM inventory_lots
WHERE part_no = :partNo AND org_id = :taskOrg
  AND sub_inventory_code = :taskSubInv AND shelf_code IS NOT NULL
ORDER BY created_date DESC, id LIMIT 1
```

"Most recent stocking decision for this part in this store" — zero new
master data, covers the common case (a part lives on its usual shelf). NULL →
no hint. Computed per read, never persisted: suggestions can't go stale.

## Test plan

- `src/db/putawaytasks.test.ts`:
  - `autoCreateTasks` on → confirm arrival creates a pending task (same tx);
    re-confirm is a no-op (unique index).
  - full put-away of the order → order clears → task completed; task list
    filters by status.
  - partial put-away → task stays pending; `unboxedItems` decreases.
  - suggested shelf: seed a lot for the part in the task's store → suggestion
    = its shelf; no history → `null`; `suggestShelf: "off"` → field `null`.
  - `autoCreateTasks` off (default) → no task rows on arrival (current
    behavior preserved).
- Config parse tests (`src/config.test.ts`): new keys accepted on `put-away`,
  rejected elsewhere, bad enum/boolean throws, `enabled:false` +
  `autoCreateTasks:true` only warns.

## Explicitly not in v1

- Operator assignment / work locks on tasks.
- Fixed-slot or capacity-aware slotting (`parts.default_shelf_code`, zones) —
  new `suggestShelf` strategy values when a warehouse asks.
- Admin UI for tasks; manual complete/cancel endpoints.
- Task generation for orders confirmed *before* the flag is turned on (the
  candidates list still covers them; a backfill script is one UPDATE away if
  ever needed).
