# Flow config: `allowedOrgIds` — per-warehouse org partition filter

Status: implemented 2026-09-01. Extends `2026-08-10-flow-config-design.md` /
`2026-08-12-admin-flow-config-design.md`.

## Problem

Stock/doc tables are partitioned by `org_id` (integer office id) +
`sub_inventory_code`, and one backend instance may hold rows for several orgs
(e.g. after upstream sync). A warehouse physically works only a subset of those
orgs; today every list endpoint returns every partition.

## Setting

New top-level key in the flow-config JSON (`warehouse_config` row `"flow"`,
`FLOW_CONFIG` env override, admin `PUT /admin/flow-config` — all validated by
`mergeFlowConfigJson`):

```json
{ "allowedOrgIds": [2, 3] }
```

- Type: array of integers. Anything else fails validation (boot / 400 on PUT).
- Default `[]` = **accept all orgs, no filtering** — the seeded `{}` row and
  existing deployments are unaffected.
- When non-empty the filter is **strict**: rows whose `org_id` is NULL or not
  in the list are hidden. (`picking_orders.org_id` / `inventory_lots.org_id`
  are nullable; ingest defaults org_id to 2, so NULLs are legacy/demo-only.)
- Admin PUT applies at runtime via `applyFlowConfig` — no restart needed.

## Filter scope

Applied via `src/db/org-filter.ts` `allowedOrgFilter(column)` (`AND <col> =
ANY(...)` fragment, empty when `[]`):

| Query | Column |
| --- | --- |
| `listPickingOrders` / `getPickingOrderDetail` (404 when out of scope) | `picking_orders.org_id` |
| `GET /receiving-orders` list / `:id` detail (404) | `receiving_orders.org_id` |
| `searchStock` | `inventory_lots.org_id` |
| `listPutAwayTasks` | `put_away_tasks.org_id` |
| `listPutAwayCandidates` | `receiving_orders.org_id` |
| `listGoodsVerifyTasks` | `inventory_lots.org_id` (join via `inventory_lot_id`) |

Deliberately **not** filtered:

- verify / measuring / shipping box queues — downstream of picking; boxes can
  hold packages from several orders, so a box-level org is ambiguous. Once
  picking is filtered at the source, these queues only receive allowed-org
  work.
- `searchBoxes`, admin master-data CRUD, `allocateAll` (already scoped per
  order's org pair + share groups).

## Admin console

`/flow-config` page gains an "Accepted org IDs" text field (comma-separated
integers, empty = all). The save payload must include `allowedOrgIds` —
previously the form sent only `{ steps: {...} }`, which would wipe the key.

## PDA

`GET /config` exposes `allowedOrgIds` for completeness; the PDA does not
consume it (filtering is server-side).
