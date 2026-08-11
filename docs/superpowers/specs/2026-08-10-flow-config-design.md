# Flow configuration (FLOW_CONFIG) design

Date: 2026-08-10
Status: implemented
Supersedes: the `FLOW_STEPS_DISABLED` mechanism in
`docs/superpowers/specs/2026-07-28-verify-step-and-flow-step-config-design.md`
(which remains as a fallback input — see Compatibility).

## Amendment: warehouse_config table (2026-08-10)

The flow config moved from env-only to the database. It now lives in the
`warehouse_config` row with key `"flow"` (`src/db/schema/config.ts`) — same
JSON schema as below — seeded per warehouse (`seedAll` inserts `{key: "flow",
value: {}}`; existing DBs get the row via SQL UPDATE) and loaded once at boot
by `loadFlowConfig` (`src/config.ts`, called from `src/db.ts` after
migrate+seed). Changes are restart-to-apply; there is no mid-transaction
reload.

Precedence at boot: `FLOW_CONFIG` env (when set) > `warehouse_config` row >
defaults. A missing row is auto-created with `{}` (= defaults). An invalid
row value fails boot (fail-fast), same as invalid env JSON.
`FLOW_STEPS_DISABLED` is deprecated but still disables steps on top of the DB
row when `FLOW_CONFIG` is unset (startup warning).

The sections below remain the schema reference: read every "`FLOW_CONFIG` env
var" as the override path — the primary source is now the `warehouse_config`
`"flow"` row.

## Problem

Today put-away is not a gate: the allocation engine (`src/db/allocate.ts`)
draws from two stock sources — shelf stock (`inventory_lots`) and dock stock
(`receiving_invoice_items` of `in_hand` / `provisional_received` orders) — so a
picking order can allocate straight off the receiving dock (cross-dock). Some
warehouses require received stock to be put away before it may be allocated to
picking. Each warehouse runs its own standalone backend instance (no
`warehouse_code`), so a per-instance env config is inherently per-warehouse.

At the same time, `FLOW_STEPS_DISABLED` (comma-separated step keys) only
expresses on/off. We want one structured configuration that covers step
enablement plus behavior flags, with room to grow.

## Config schema

A single env var `FLOW_CONFIG` holding JSON. The full shape (also the
defaults when `FLOW_CONFIG` is unset):

```json
{
  "steps": {
    "receiving":    { "enabled": true },
    "put-away":     { "enabled": true },
    "picking":      { "enabled": true, "allocation": { "allowDockStock": true } },
    "measuring":    { "enabled": true },
    "verify":       { "enabled": true },
    "goods-verify": { "enabled": true },
    "stock-search": { "enabled": true }
  }
}
```

Semantics:

- `steps.<step>.enabled` — same meaning as today's `FLOW_STEPS_DISABLED`
  inverse. `measuring` / `verify` / `goods-verify` rewire server-side flow
  logic (picking finish chain, shipping feed source, day-end job); the rest
  only hide PDA home tiles via `GET /config`.
- `steps.picking.allocation.allowDockStock` — when `false`, the allocation
  engine skips dock stock (`loadReceivingSources`): received stock stays
  unallocatable until put-away materializes `inventory_lots`. Picking orders
  that cannot be covered from shelf stock simply remain
  `unallocated` / `partial` — an existing, handled state; no new UX. Default
  `true` = current cross-dock behavior.

A warehouse that requires put-away before picking deploys:

```json
{ "steps": { "picking": { "allocation": { "allowDockStock": false } } } }
```

The gate is absolute: there is no manual override to release dock stock to an
urgent order. Add one only if a warehouse actually asks for it.

## Parsing and validation

- Parsed once at import time in `src/config.ts` (same lifecycle as
  `FLOW_STEPS_DISABLED`; changes need a backend restart).
- The JSON is merged over the defaults above, so deployments only write what
  differs. Unknown keys anywhere in the object are rejected.
- Invalid JSON, wrong value types, or unknown keys → throw at startup (fail
  fast). A config that controls stock movement must never be silently
  ignored.
- Conflict rule, rejected at startup: `steps.put-away.enabled: false` together
  with `steps.picking.allocation.allowDockStock: false` is a deadlock — stock
  could never become allocatable.
- `steps.picking.enabled: false` makes the `allocation` block moot: it is
  ignored with a startup warning, not an error.

## Compatibility

- `FLOW_CONFIG` unset → defaults above (current behavior, zero migration).
- `FLOW_CONFIG` unset and `FLOW_STEPS_DISABLED` set → the legacy var maps onto
  `steps.<step>.enabled` exactly as today.
- Both set → `FLOW_CONFIG` wins; a startup warning notes that
  `FLOW_STEPS_DISABLED` is ignored.

## API surface

`GET /config` keeps its existing `flowSteps: Record<FlowStep, boolean>` field
(shape unchanged — the PDA's `useFlowSteps` needs no change) and gains the
resolved picking allocation policy:

```json
{
  "flowSteps": { "receiving": true, "...": true },
  "pickingAllocation": { "allowDockStock": false }
}
```

## Server-side wiring

- `src/config.ts` — parse/validate/export the flow config; `isStepEnabled`
  reads from it; new `allowDockStock()` accessor; test-only override
  `_setPickingAllocationForTests` alongside `_setFlowStepsDisabledForTests`.
- `src/db/allocate.ts` — in `allocateAll`, the receiving-source pass (step 2)
  is skipped when `allowDockStock()` is false.
- `src/db/picking.ts`, `src/db/measuring.ts`, `src/db/shipping.ts`,
  `src/db/goodsverify.ts` — keep calling `isStepEnabled`; no signature change.

## Test plan

- `src/db/allocate.test.ts`: with dock stock disallowed, a demand that only
  has in-hand receiving stock stays `unallocated`; after put-away
  materializes the lot, `allocateAll` allocates it. With the default config,
  the existing cross-dock tests pass unchanged.
- Config parsing unit tests: defaults, partial merge, unknown key → throw,
  invalid JSON → throw, put-away-disabled + dock-disallowed conflict → throw,
  `FLOW_STEPS_DISABLED` fallback mapping.
