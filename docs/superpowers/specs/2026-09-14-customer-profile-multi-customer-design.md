# Customer profiles: multi-customer membership, jsonb rule, ingest removal — design

Date: 2026-09-14. Supersedes the linkage convention from
`2026-09-10-customer-profiles-accounts-design.md` (profile `code` = `party_name`, 1:1).

## Goals

1. **One profile ↔ many customers.** A `customer_profiles` row carries the list of
   customers (party names) it applies to. A customer belongs to at most one profile.
2. **`picking_orders.customer_code` is plain synced text.** It mirrors the upstream
   customer (looked up in `customer_accounts.party_name`); the FK to
   `customer_profiles.code` is dropped so upstream sync can write orders for any
   customer without a local profile existing first.
3. **`customer_profiles.rule` becomes `jsonb`** for structured, extensible
   per-customer requirements (still stored, not interpreted by allocation).
4. **Remove `src/db/ingest.ts`.** The ingest HTTP API was retired 2026-08; the
   external sync service now writes the DB directly and never calls the apply-layer
   functions. The module (plus its dedicated tests) is deleted; backend tests that
   used its upsert helpers as fixtures switch to direct Drizzle inserts.

## Non-goals

- No interpretation of `rule` by allocation or any other flow.
- No changes to `customer_accounts` (upstream-synced, read-only).
- No FK from profile membership to `customer_accounts` — `party_name` is not unique
  there (PK is `cust_account_id`), and membership stores the same party-name text
  that `picking_orders.customer_code` carries, by convention.

## Schema changes (`apps/backend/src/db/schema/`)

### `customer_profiles` (master.ts)

- `rule`: `text` → `jsonb("rule").$type<Record<string, unknown>>()`, nullable.
  Migration converts existing values with
  `USING (CASE WHEN rule IS NULL OR btrim(rule) = '' THEN NULL ELSE to_jsonb(rule) END)`
  (legacy free text becomes a JSON string; none exists outside demo data).
- New `customers`: `jsonb("customers").$type<string[]>().notNull().default(sql`'[]'::jsonb`)` —
  array of `customer_accounts.party_name` values this profile applies to.
  Chosen over a junction table because `party_name` is not unique in
  `customer_accounts` (a relational FK is impossible) and the lookup key used
  everywhere downstream (`picking_orders.customer_code`) is the party-name text.

### `picking_orders` (picking.ts)

- `customerCode`: drop `.references(() => customerProfiles.code)`; stays
  `text("customer_code")`, nullable. Comment updated: opaque upstream customer text
  (by convention a `customer_accounts.party_name`), no FK — same convention as
  `parts.part_no` / `brand`.

## Backend behavior

### Membership uniqueness (app-level)

A party name may appear in at most one profile's `customers`. Enforced in the
admin route on create/update/assign (409 `customer_already_assigned` naming the
conflicting profile); there is no DB constraint (impractical on a jsonb array).

### Admin API (`apps/backend/src/routes/admin/`)

Replace the generic `createCrudRouter` for `/customer-profiles` with a custom
router `customerProfiles.ts` (same pattern as `subInventories.ts`):

- `GET /` — full list (unchanged shape, now includes `customers` and jsonb `rule`).
- `GET /:code`, `DELETE /:code` — unchanged semantics.
- `POST /` — body `{id?, code, label, rule?, remark?, customers?}`; `rule` must be a
  JSON object (`optJson`); `customers` an array of non-empty strings
  (`optStrArray`, stored as `[]` when omitted); rejects with 409
  `customer_already_assigned` if any party name is already in another profile.
- `PATCH /:code` — partial `{label?, rule?, remark?, customers?}`; same validation;
  `customers` replaces the whole array.
- `PUT /:code/customers` body `{add?: string[], remove?: string[]}` — atomic
  membership edit used by the admin customer detail page when assigning a customer
  to a profile; add-side runs the uniqueness check.

A party name is unassigned by removing it from its profile's `customers`
(`PUT /:code/customers {remove:[...]}`); there is no separate unassign endpoint.

### receivingShipper join (`apps/backend/src/routes/admin/receivingShipper.ts`)

The two `LEFT JOIN customer_profiles cp ON cp.code = po.customer_code` joins become
`LEFT JOIN customer_profiles cp ON cp.customers ? po.customer_code` (jsonb array
element-exists operator). NULL `customer_code` never matches, as before.

### Ingest removal

Delete `src/db/ingest.ts`, `src/db/ingest.test.ts`, `src/db/ingest-masterdata.test.ts`.
No non-test source imports the module (verified by grep). The
`app.sync_events_off` trigger suppression stays — seed/reset sets it directly via
`SET LOCAL`. Rewrite the fixture usage in the remaining tests with direct Drizzle
inserts:

- `src/db/events.test.ts` — was testing ingest event emission; rewrite around direct
  inserts (or trim to what direct writes emit).
- `src/db/sync-events.test.ts` — keep the trigger-suppression tests; the
  "ingest writes are suppressed" test is dropped (no ingest path left).
- `src/db/putaway.test.ts`, `src/db/putawaytasks.test.ts`,
  `src/routes/admin/receivingShipper.test.ts` — replace `upsertReceivingOrder` /
  `upsertPickingOrder` fixtures with direct inserts of the rows each test needs.

### Seed (`src/db/seed.ts`)

Seeded profiles gain `customers` matching the demo order data so the shipper label
lookup still resolves: `ACME → ["ACME"]`, `HK-SUN64 → ["HK-SUN64"]`,
`HK-WIN84 → ["HK-WIN84"]` (the demo `picking_orders.customer_code` values).
`customer_accounts` stays unseeded (arrives via upstream sync).

## Admin UI (`apps/admin`)

### List page `pages/customer-profiles/index.vue`

- `profileFor(partyName)` now matches `profile.customers.includes(partyName)`.
- The status/profile dropdown filters keep working on top of the new matching.
- Add a read-only "Profile" column showing the assigned profile's `label`.

### Detail page `pages/customer-profiles/[partyName].vue`

- Account card unchanged.
- Profile card gains an **assigned profile** `<select>` (all profiles + "None") —
  changing it calls `PUT /admin/customer-profiles/<code>/customers` add/remove and
  updates the local state.
- **Create new profile** option: prompts for a `code`, POSTs with the current
  party name as the sole member, then selects it.
- The label/rule/remark form edits the currently assigned profile.
  `rule` becomes a JSON `<textarea>` — validated with `JSON.parse` on save;
  invalid JSON blocks the save with an inline error.

### i18n (`layers/i18n`)

New keys under `admin.pages.customerProfiles` / `admin.pages.customerProfile` in
`en-US`, `zh-CN`, `zh-HK`: profile column label, assign select labels, none/create
options, JSON rule placeholder + invalid-JSON error, `customer_already_assigned`
error surface.

## Docs to update

- `docs/backend/schema-tables.md` — `customer_profiles` columns, `picking_orders.customer_code` row.
- `docs/backend/api-design.md` — Upstream sync section: drop the "Inbound apply
  layer" bullet (module removed); admin `/customer-profiles` endpoints.
- `AGENTS.md` — "Upstream sync" bullet: remove the `src/db/ingest.ts` mention.
- `docs/app-docs/admin-user-menu/index.md` — customer-profiles section:
  membership by `customers` array (no longer `code = party_name`).

## Verification

- `docker compose up -d`; `pnpm --filter @warehouse/backend test` green.
- `pnpm --filter @warehouse/backend build` (tsc) green.
- `pnpm --filter @warehouse/admin exec nuxi typecheck` — no new errors
  (4 pre-existing in flow-config.vue / locale-persistence).
- Manual: admin login → customer profiles list filters; assign a customer to a
  profile; create a profile; save jsonb rule; shipper download shows profile label.
