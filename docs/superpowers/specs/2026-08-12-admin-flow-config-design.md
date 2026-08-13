# Admin console: flow config editing

Date: 2026-08-12
Status: implemented
Builds on: `2026-08-10-flow-config-design.md`

## Problem

The flow config (which steps are on, put-away task mode, dock-stock
allocation policy) lives in the `warehouse_config` row `"flow"` and can only
be changed by SQL or the `FLOW_CONFIG` env override. Operators/admins need a
UI.

## Design

### Backend: `GET/PUT /admin/flow-config`

- `GET` → `{ config, stored, envOverride }`:
  - `config` — the **stored** row merged over the defaults (what the form
    edits; differs from the runtime config when the env override is active)
  - `stored` — the raw `warehouse_config` row value (partial JSON)
  - `envOverride` — true when `FLOW_CONFIG` env is set (DB edits then have no
    effect until the env var is removed; the admin UI shows a warning)
- `PUT` — body is a partial flow-config JSON (same shape/validation as the
  env var, via `mergeFlowConfigJson`; invalid → 400 with the validator's
  message). Upserts the `"flow"` row and applies immediately at runtime
  (`applyFlowConfig`) **unless** the env override is active (then it only
  persists; response `applied: false`). Returns the saved config (not the
  runtime one) so the form keeps the just-saved values. No backend restart
  needed anymore for DB-driven changes.

Config gains a `getFlowConfig()` getter and an `applyFlowConfig()` setter
(the module state was previously boot-only). The PDA reads `GET /config`
once per login, so it picks up changes on next login/refresh.

### Admin UI: `/flow-config` page (Settings section)

Structured form over the known keys — no raw JSON editing:

- one `enabled` checkbox per flow step (receiving, put-away, picking,
  goods-verify, measuring, verify, stock-search)
- `picking.allocation.allowDockStock` checkbox
- `put-away.autoCreateTasks` checkbox
- `put-away.suggestShelf` select (`existing-stock` / `off`)

Save sends the fully-expanded `steps` JSON. A warning banner shows when
`envOverride` is true. The validator's conflict rule (put-away disabled +
allowDockStock=false) surfaces as the save error.

## Non-goals

- No per-key history/audit (config changes are rare, admin-only POC).
- No re-allocation trigger when the allocation policy flips (next
  stock-changing commit recomputes as usual).
