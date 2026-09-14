# Customer profiles: multi-customer membership, jsonb rule, ingest removal — plan

Spec: `docs/superpowers/specs/2026-09-14-customer-profile-multi-customer-design.md` (read it first).

## Backend

1. **Schema** (`apps/backend/src/db/schema/master.ts`, `schema/picking.ts`)
   - `customer_profiles.rule`: text → `jsonb` (`$type<Record<string, unknown>>()`).
   - `customer_profiles.customers`: new `jsonb` `$type<string[]>()`, notNull, default `'[]'::jsonb`.
   - `picking_orders.customerCode`: drop `.references(() => customerProfiles.code)`; update comment.
2. **Migration**: `pnpm --filter @warehouse/backend db:generate`, then hand-edit the
   generated SQL: `rule` type change needs
   `USING (CASE WHEN rule IS NULL OR btrim(rule) = '' THEN NULL ELSE to_jsonb(rule) END)`;
   confirm it also drops the FK constraint on `picking_orders.customer_code`.
3. **Admin route**: new `apps/backend/src/routes/admin/customerProfiles.ts` custom router
   (pattern: `subInventories.ts`) replacing the `createCrudRouter` block in
   `routes/admin/index.ts:169-188`; create/update accept `customers` (optStrArray → `[]`)
   and `rule` (optJson); `PUT /:code/customers {add?, remove?}`; uniqueness check
   (409 `customer_already_assigned`) scanning other profiles' `customers`.
4. **receivingShipper.ts**: both joins → `cp.customers ? po.customer_code`.
5. **Seed**: `seed.ts:377-382` profiles get `customers` arrays (`ACME`/`HK-SUN64`/`HK-WIN84`).
6. **Ingest removal**: delete `src/db/ingest.ts`, `ingest.test.ts`,
   `ingest-masterdata.test.ts`; rewrite fixture usage to direct Drizzle inserts in
   `events.test.ts`, `sync-events.test.ts`, `putaway.test.ts`, `putawaytasks.test.ts`,
   `routes/admin/receivingShipper.test.ts`.
7. Backend docs: `docs/backend/schema-tables.md`, `docs/backend/api-design.md`
   (drop "Inbound apply layer" bullet, update `/customer-profiles` rows), `AGENTS.md`
   (drop `src/db/ingest.ts` from the Upstream sync bullet).
8. Verify: `docker compose up -d`; `pnpm --filter @warehouse/backend test`; `pnpm --filter @warehouse/backend build`.

## Admin UI (parallel — API contract pinned by spec §Admin API)

9. `pages/customer-profiles/index.vue`: membership matching via `customers.includes`;
   keep the status/profile dropdowns; add read-only Profile (label) column.
10. `pages/customer-profiles/[partyName].vue`: assigned-profile select (+ None,
    + create-new flow), membership via `PUT /:code/customers`; label/rule/remark edit
    the assigned profile; `rule` as JSON textarea with `JSON.parse` validation.
11. i18n keys in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`.
12. Verify: `pnpm --filter @warehouse/admin exec nuxi typecheck` (no new errors).

## Docs (admin-side)

13. `docs/app-docs/admin-user-menu/index.md` customer-profiles section.
