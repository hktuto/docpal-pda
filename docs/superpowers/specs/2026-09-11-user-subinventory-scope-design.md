# Per-user sub-inventory scope — design

Date: 2026-09-11
Status: approved

## Problem

Warehouse users (admin console or PDA) currently see receiving/picking data for every
sub-inventory the warehouse serves (bounded only by the warehouse-wide flow config
`allowedOrgIds`). Teams want a per-user global filter: a user scoped to one or more
sub-inventories only sees data belonging to those sub-inventories, on the receiving order
and picking order pages, without having to filter manually each time.

## Decisions

- **Separate `user_profiles` table**, not a column on `users`. `users` is a minimal
  DocPal-provisioned auth mirror whose header notes it may be replaced by a ucenter sync
  later; a profile table keyed by the `username` business key survives that, and lets
  admin pre-create a profile before the user's first login (the users row only exists
  after login). Same rationale as `supplier_profiles` vs `suppliers`.
- **Scope values are `(org_id, secondary_inventory_name)` pairs**, because sub-inventory
  identity is the composite key in `org_info` — a code alone is not unique across orgs.
- **NULL `sub_inventory_code` stays visible.** Rows only get stamped at confirm-arrival
  (receiving items) or by the upstream sync (picking orders); hiding NULLs would make
  freshly synced data vanish from the people who need to work it.
- **Empty/absent scope = unrestricted.** The filter only applies once at least one pair
  is set.
- **Enforcement is server-side** in the shared flow endpoints (`/receiving-orders`,
  `/picking-orders` list + detail). The admin console and the PDA both call these, so
  one enforcement point covers both apps. Mutations/scans are not filtered.
- **Applies to receiving + picking only.** Stock search, put-away, goods verify keep the
  warehouse-wide `allowedOrgIds` behavior only.
- Composes with `allowedOrgIds` by AND — a row must pass both filters.

## Schema

`user_profiles` (in `apps/backend/src/db/schema/master.ts`):

| column | type | notes |
|---|---|---|
| `id` | text PK | `newId()` (UUID v7) |
| `username` | text NOT NULL UNIQUE | business key matching `users.username`; **no FK** — profile may pre-exist the users row |
| `sub_inventory_scopes` | jsonb NULL | `[{ "orgId": number, "code": string }]`; NULL/[] = unrestricted |
| `created_date` / `last_update_date` | timestamp | standard defaults |

## Filter semantics

For a row carrying `(org_id, sub_inventory_code)`:

```
sub_inventory_code IS NULL
  OR (org_id, sub_inventory_code) IN ((org1, code1), (org2, code2), ...)
```

Helper lives in `apps/backend/src/db/user-scope.ts` next to `org-filter.ts`:
`getUserScope(db, username)` + `userScopeCondition`/`userScopeFilter` fragments.

### Per endpoint

- **Picking list / detail** — `picking_orders` carries the pair directly; plain predicate
  on `po.org_id` / `po.sub_inventory_code`. Out-of-scope detail = 404.
- **Receiving list** — `receiving_orders` has only `org_id`; the pair lives on
  `receiving_invoice_items`. An order stays visible when it has **no items**, or **any
  item** that is unstamped (NULL) or in scope. List aggregates (item counts etc.) are
  unchanged — computed over all items.
- **Receiving detail** — same order-level predicate (404 when out of scope); the
  returned items list is additionally filtered to in-scope/NULL items.

## API

Self-service (`apps/backend/src/routes/auth.ts`):

- `GET /auth/me/profile` → `{ username, subInventoryScopes: [{ orgId, code }] }`
- `PUT /auth/me/profile` — body `{ subInventoryScopes: [...] }`; every pair validated
  against `org_info` (400 `unknown_sub_inventory` with the bad pairs listed); upsert by
  the actor's username.

Admin (`apps/backend/src/routes/admin/userProfiles.ts`):

- `GET /admin/user-profiles` → users LEFT JOIN profiles:
  `{ id, username, displayName, groupCodes, subInventoryScopes }[]`
- `PUT /admin/user-profiles/:username` — same validation + upsert; username need not
  exist in `users` yet (pre-provisioning).

## Admin UI

- `components/SubInventoryScopePicker.vue` — org-grouped checkbox list of `org_info`
  pairs (from `GET /admin/sub-inventories`), v-model `[{ orgId, code }]`, hint that
  empty = unrestricted. Shared by both pages.
- `pages/user-profiles.vue` — user table + per-user edit dialog (settings nav section).
- `pages/settings.vue` — personal settings page, picker bound to `/auth/me/profile`,
  linked from the user popover in `app.vue`.
- Receiving/picking list pages need no change — the backend filters.

## Out of scope

- PDA (`apps/web`) settings UI (enforcement still applies there via the shared endpoints).
- Filtering stock search / put-away / goods verify by user scope.
- Filtering mutations or SSE events.
