# Multi-warehouse configurable design

Date: 2026-10-09
Status: active

## Context

The system serves multiple warehouses (HK today, SZ as the second). Each warehouse is a **separate backend instance + separate database** — there is no `warehouse_code` column; stock partitions by `org_id` + `sub_inventory_code` (see `docs/backend/concepts.md` §3).

Warehouse-exclusive differences encountered so far:

| Difference | Example |
|------------|---------|
| Shelf layout (seed data) | HK zones/codes vs SZ zones/codes |
| Flow config (behavior) | `allowedOrgIds`, sub-inventory rules, step enablement |
| Label layout (presentation) | SZ shelf labels have a light border for cutting |

## Decision: configurable, not git branches

**Chosen:** one codebase, warehouse differences expressed as **config values** (env vars, seed files, flow config) — never separate git branches.

**Why not branches:**

- A branch separates *code versions over time*; warehouses are *deployments of the same code*. Branches would force cherry-picking every bugfix between warehouse variants and still require the same code to run as either warehouse.
- The admin/PDA binaries must be warehouse-agnostic (one build serves all warehouses).

**Patterns (in order of preference):**

1. **Flow config** (`warehouse_config` row `"flow"`, editable at runtime via `GET/PUT /admin/flow-config`) — for behavior differences (step enablement, org scoping, sub-inventory rules, display templates). No redeploy needed.
2. **Seed-time data files + `WAREHOUSE_CODE` selector** — for per-warehouse seed data (shelf layouts, default flow config). The env var picks the file at boot-seed time (empty `warehouse_config` only).
3. **Runtime detection via `/config`** — the admin/PDA fetch `/config` on mount; the backend returns `warehouseCode` (from `WAREHOUSE_CODE` env). Clients use it to pick presentation variants (e.g. label borders) without a rebuild.
4. **Strategy/factory keyed on `WAREHOUSE_CODE`** — only for warehouse-specific *behavior* that can't be expressed as config (e.g. `shelfDisplayName` variants). Both variants ship in every deploy.

## Warehouse selection

| Instance | `WAREHOUSE_CODE` | Seeds |
|----------|------------------|-------|
| HK | unset / `HK1` | `seed-shelves-hk.ts` + `HK_FLOW_CONFIG` |
| SZ | `sz` | `seed-shelves-sz.ts` + `SZ_FLOW_CONFIG` |

`WAREHOUSE_CODE` only takes effect at boot-seed time (empty `warehouse_config`). On an already-seeded DB, change the flow config via `/admin/flow-config` or re-seed.

## Label layout example (SZ border)

- Backend `/config` returns `warehouseCode` (runtime, from env).
- Admin `useWarehouseLabelLayout` composable fetches `/config`, returns `{ border: true }` for SZ.
- `apps/admin/utils/print.ts` render functions accept a `LabelLayout` param; `border: true` draws a light gray border around each label.
- Same admin build serves both warehouses — no rebuild needed; the border appears based on which backend the admin points at.

## Adding a new warehouse

1. Create `apps/backend/src/db/seed-shelves-<wh>.ts` (mirror the HK file).
2. In `src/db/seed.ts`: import the rows, add a `<WH>_FLOW_CONFIG` const, extend the `WAREHOUSE_CODE` selector in `seedReferenceOnly()`.
3. Deploy with its own `DATABASE_URL` and `WAREHOUSE_CODE=<wh>`.
4. If the warehouse needs different presentation, extend `/config` + a composable (pattern 3 above) — don't fork the admin/PDA.
