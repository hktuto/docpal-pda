# Task Assignee for PDA Queues — Design

Date: 2026-11-01
Status: implemented

## Problem

Every PDA work queue (picking, labeling, put-away, CN receiving scan, measuring,
verify) shows the same list to every logged-in operator. Supervisors assign work
verbally or on paper; two operators can open the same task, and a large queue
forces everyone to scroll past work that is not theirs.

## Decision

Add an **optional assignee** to each assignable task row. A NULL assignee means
"unassigned — visible to everyone"; once set to a username, only that user sees
the task in the PDA list and detail endpoints (the detail 404s for everyone
else). Assignment is admin-managed; there is no self-claim and no PDA-side
assignment.

### Schema

New nullable `assignee` text column (migration 0046) on the six tables backing
the PDA queues:

| table | queue |
| --- | --- |
| `receiving_orders_cn` | CN receiving scan (收貨掃描) |
| `picking_orders` | picking + labeling (the same order row drives both lists) |
| `put_away_tasks` | put-away (standard) |
| `put_away_tasks_cn` | CN put-away |
| `shipping_boxes` | measuring |
| `verify_tasks` | verify |

The column is a plain username string with **no FK** — an assignment may
pre-exist or outlive the `users` row (same convention as `user_profiles`,
which is keyed by username with no FK). No status/workflow change: the
assignee never blocks work, it only filters visibility, so any operator can
still act on an assigned task reached by other means (e.g. direct mutation
routes are unfiltered).

### Server-side filtering

One helper, `assigneeFilter(column, username)` in
`apps/backend/src/db/user-scope.ts` (next to the sub-inventory scope helpers),
returns an `AND (assignee IS NULL OR assignee = :username)` fragment; empty
when no username is given so admin/shared callers stay unfiltered. Applied,
composed by AND with the existing org/sub-inventory scope, to:

- `GET /receiving-cn/scan-tasks` (+ `/:id`)
- `GET /picking-orders` (+ `/:id`)
- `GET /labeling-orders`
- `GET /put-away-tasks` (+ `/:id`)
- `GET /put-away/candidates` (LEFT JOIN `put_away_tasks` — a candidate whose
  order has a task assigned to someone else is hidden from other users)
- `GET /put-away-cn/tasks` (+ `/:id`)
- `GET /measuring-boxes` (+ `/:id`)
- `GET /verify-tasks` (+ `/:id`)

Reads only — mutations, allocation and SSE events are unaffected.

### Admin API

`apps/backend/src/db/taskAssignments.ts` + `src/routes/admin/taskAssignments.ts`:

- `GET /admin/task-assignments?flow=` — the open tasks of one flow
  (`receiving-cn` | `picking` | `labeling` | `put-away` | `put-away-cn` |
  `measuring` | `verify`) with label/status/assignee, for the picker UI;
  **includes every assignee** (this is where assignments are managed).
- `PATCH /admin/task-assignment` `{flow, id, assignee|null}` — set or clear one
  task's assignee (empty string also clears). The username is deliberately not
  validated against `users` (an assignment may pre-exist the user row). 404
  `task_not_found` on an unknown id; writes a `transaction_logs` audit row
  (from/to = the old/new assignee).

### Admin UI

- New page `apps/admin/pages/task-assignments.vue` (nav entry in the Settings
  section of `utils/entities.ts`): one tab per flow over
  `GET /admin/task-assignments`, with a `SearchableSelect` user picker fed by
  `GET /admin/users`.
- Inline assignee editors on the picking order detail
  (`pages/picking-orders/[id].vue`) and the CN receiving order detail
  (`pages/receiving-cn/[batchNo].vue`).

### PDA

List-row DTOs carry `assignee`. `AppListRow.vue` gains a `mineText` prop that
renders a `badge--assigned` badge (style in `apps/pda/assets/css/main.scss`);
the `useAssignedToMe.ts` composable compares `row.assignee` to the logged-in
username and is wired into the six list pages (`receiving-cn-scan`, `picking`,
`put-away`, `labeling`, `measuring`, `verify`) — an assigned-to-me row gets
the badge, and the server already hid rows assigned to others. `assignee` is
also a template token in `PDA_LIST_FIELDS`
(`apps/pda/utils/listRowTemplate.ts` + the admin mirror) so list templates can
render it; i18n key `common.assignedToMe` in all three locales.

## Out of scope

- **Goods-verify** — a day-end generated sweep, not assignable work.
- **Standard (non-CN) receiving** — receiving orders are confirmed by whoever
  is at the dock; only the CN scan queue got an assignee.
- **Self-claim / PDA-side assignment** — assignment is admin-only.
- **SSE / push notification on assignment** — no new events; PDA lists pick up
  assignments on their existing reload triggers.
- **Blocking** — the assignee filters visibility only; it never locks a task
  against other users' mutations.

## Alternatives considered

- **FK to `users(id)`**: rejected — assignments must survive upstream user
  churn and may pre-exist the user row; the username string mirrors
  `user_profiles`.
- **Claim-based queueing (first operator to open owns the task)**: rejected —
  supervisors assign work explicitly; the existing picking work lock already
  covers concurrent-edit protection.
- **Per-task table for all queues**: rejected — the queues already live on six
  different tables (orders, tasks, boxes); one uniform nullable column per
  table plus one filter helper is the smaller change.
