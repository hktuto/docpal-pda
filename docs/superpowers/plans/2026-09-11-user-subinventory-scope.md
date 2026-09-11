# Per-user sub-inventory scope — implementation plan

Date: 2026-09-11
Spec: `docs/superpowers/specs/2026-09-11-user-subinventory-scope-design.md`

## 1. Backend — schema + migration

`apps/backend/src/db/schema/master.ts` — add `userProfiles` table (next to `users`):
`id` text PK, `username` text NOT NULL UNIQUE (no FK), `subInventoryScopes` jsonb,
`createdDate`/`lastUpdateDate`. Then `pnpm --filter @warehouse/backend db:generate` →
new migration `apps/backend/drizzle/0004_*.sql` (auto-applies on startup).

## 2. Backend — scope helper

New `apps/backend/src/db/user-scope.ts` (sibling of `org-filter.ts`):

- `getUserScope(db, username): Promise<{ orgId: number; code: string }[] | null>`
- `userScopeCondition(orgCol: SQL, subCol: SQL, scope): SQL | undefined` —
  `( <subCol> IS NULL OR (<orgCol>, <subCol>) IN (...) )`
- `userScopeFilter(orgCol, subCol, scope): SQL` — `AND <cond>` fragment.

## 3. Backend — apply to receiving + picking reads

- `apps/backend/src/db/picking.ts` `listPickingOrders` (~line 527): new `opts.scope`,
  predicate next to `allowedOrgFilter` (line 559). `getPickingOrderDetail` (~line 770):
  new `scope` param, same predicate (line 790) → out-of-scope = 404.
- `apps/backend/src/routes/picking.ts`: `GET /picking-orders` + `GET /picking-orders/:id`
  resolve `getUserScope(db, actorFrom(c).username)` and pass it down.
- `apps/backend/src/routes/receiving.ts` `GET /receiving-orders` (list): order visible
  when it has no items or any item NULL/in-scope (EXISTS subquery); aggregates unchanged.
  `GET /receiving-orders/:id`: same order-level predicate → 404; items query filtered to
  in-scope/NULL items.

## 4. Backend — endpoints

- `routes/auth.ts`: `GET /auth/me/profile`, `PUT /auth/me/profile` (validate pairs
  against `org_info`, 400 `unknown_sub_inventory`; upsert by actor username).
- New `routes/admin/userProfiles.ts` mounted in `routes/admin/index.ts`:
  `GET /admin/user-profiles` (users LEFT JOIN profiles), `PUT /admin/user-profiles/:username`
  (same validation; pre-provisioning allowed).

## 5. Admin UI (`apps/admin`)

- `utils/entities.ts`: `/user-profiles` link in the settings nav section.
- `components/SubInventoryScopePicker.vue`: org-grouped checkbox list from
  `GET /admin/sub-inventories`, v-model `[{ orgId, code }]`, empty = unrestricted hint.
- `pages/user-profiles.vue`: user table + edit dialog → `PUT /admin/user-profiles/:username`.
- `pages/settings.vue`: personal settings bound to `GET/PUT /auth/me/profile`; link from
  the `app.vue` user popover.
- i18n keys in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`.
- No changes on receiving/picking list pages (server filters).

## 6. Tests

`apps/backend/src/db/user-scope.test.ts` + route tests following
`org-filter.test.ts`/`auth.test.ts`: NULL visible, pair match, unrestricted when unset;
picking list/detail scoping (404); receiving list EXISTS semantics + detail item
filtering; profile PUT validation + upsert + pre-provisioning.

## 7. Docs

Update `docs/backend/api-design.md`, `docs/backend/schema-tables.md`, `AGENTS.md`
(schema keys mention), `docs/app-docs/ai/feature-registry.md`, `code-map.md`, and the
receiving/picking flow `ai-scope.md` files.

## 8. Verification

1. `docker compose up -d`; `pnpm --filter @warehouse/backend test`; `pnpm --filter @warehouse/backend build`.
2. `pnpm --filter @warehouse/admin nuxt prepare`.
3. Manual: `pnpm dev:backend` + `pnpm dev:admin`; set a scope on `/settings`; verify
   receiving/picking lists (admin + PDA web) are scoped; clear scope; verify restored.
