# TN picking orders: org-aware visibility

Date: 2026-10-27
Status: implemented

## Background

Picking list/detail visibility splits by `picking_order_type`
(`pickingOrderOrgFilter` in `apps/backend/src/db/picking.ts`):

- `invoice` → the flow config's `allowedOrgIds` AND the caller's exact
  `(org_id, sub_inventory_code)` scope pairs;
- `tn` (transfer) → the order's org was **ignored entirely**: visible whenever
  the caller's scope covered ANY sub-inventory of the hardcoded
  `TN_ORG_ID = 143` (NCI), invisible otherwise. Unscoped callers saw all
  transfers.
- `NULL` → unfiltered (freshly synced orders carry no type yet).

The 143 gate exists because upstream TN orders arrive stamped with the
*requesting* office's org (observed: 5, 7, 12, 14, 220 — never 143), while NCI
coordinates the transfers; the earlier `org_id = 143` row requirement would
have hidden every transfer, so the rule was relaxed to ignore the order org
(commit `604e8d71`).

The gap: a transfer belonging to another office — e.g. order `TH-26100001`
(org 220 NTH, destination sub-inventory `THTH1`, stock sourced from `THHK2`) —
is invisible to that office's own users unless they are also granted an NCI
store in their `user_profiles.sub_inventory_scopes`. Scope grants are meant to
reflect which stores a user works in, not to leak an unrelated office's store
just to unlock transfer visibility.

## New rule

A `tn` order is visible to a **scoped** caller when ANY of:

1. the scope covers any sub-inventory of the **order's own org**
   (`scope.some(e => e.orgId === order.org_id)`) — "transfers belong to the
   org, not to one store", so the sub-inventory is not matched for `tn`;
2. the scope covers any sub-inventory of org `143` (NCI keeps its global view
   of all transfers — unchanged);
3. the order's `org_id` is NULL (unstamped rows stay visible — same philosophy
   as NULL-typed orders and the NULL-sub-inventory rule).

Unscoped callers (no/empty scope) still see all transfers. The `invoice` and
`NULL`-type branches are unchanged, and `allowedOrgIds` still does not apply
to `tn` orders (unchanged).

## Implementation

`pickingOrderOrgFilter` gains a per-row `tn` condition when the caller is
scoped without any 143 pair:

```sql
(picking_order_type = 'tn'
 AND (org_id IS NULL OR org_id IN (<scope org ids>)))
```

Scoped callers WITH a 143 pair and unscoped callers keep the static
`picking_order_type = 'tn'` clause (all transfers).

## Touch points

- `apps/backend/src/db/picking.ts` — `pickingOrderOrgFilter` (list +
  detail reads both go through it).
- `apps/backend/src/db/user-scope.test.ts` — the type-split visibility test
  gains an org-220 TN fixture and updated expectations.
- `docs/app-docs/flows/picking/ai-scope.md` — rule description.

No API shape, schema, or config changes; no PDA/admin UI changes (the filter
is server-side).
