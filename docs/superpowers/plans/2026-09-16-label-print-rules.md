# Label Print Rules — admin settings page (plan)

Spec: `docs/superpowers/specs/2026-09-16-label-print-rules-design.md`

Status: implemented 2026-09-16.

## Goal

Admin-managed rules that decide which print template to use when printing labels during picking (web-side printing comes later). Each rule = a flat AND/OR condition list + label type (`carton` | `item_box` | `item`) + linked print template ID. Full CRUD + activate/deactivate in the admin console, with a structured condition editor (no raw JSON typing).

## Rule model (confirmed with user)

- **Flat AND/OR**: one list of conditions combined by a single combinator (`and` / `or`). A rule may use any subset of fields (e.g. just `org_id + customer`).
- **Conditions JSON** stored in a `conditions` jsonb column:
  ```json
  {
    "combinator": "and",
    "conditions": [
      { "field": "org_id",        "operator": "eq",    "value": "2" },
      { "field": "supplier",      "operator": "match", "value": "ACME*" },
      { "field": "order_no",      "operator": "match", "value": "319*" },
      { "field": "customer",      "operator": "eq",    "value": "C001" },
      { "field": "sub_inventory", "operator": "eq",    "value": "HK-01" }
    ]
  }
  ```
  - `field` ∈ `org_id | sub_inventory | supplier | order_no | order_type | customer`
  - `operator` ∈ `eq` (exact, case-sensitive) | `match` (glob, `*` matches any sequence; plain string = exact — same convention as `receivingSubInventoryRules.poNoPattern`)
  - `value`: non-empty string (`org_id` must be numeric)
  - At least 1 condition required.
- **`label_type`** ∈ `carton | item_box | item`.
- **`print_template_id`** — free-text string = upstream print service template slug (e.g. `katata-label`). No template-list API exists upstream; user will supply template IDs later. Admin field shows a hint with known slugs from `docs/backend/print-service.md`.
- **`priority`** (integer, default 100) — evaluation order when several active rules match (ascending; contract for the later web picking flow: first matching active rule wins).
- **`active`** boolean default true.
- No `sync_events` trigger (admin-local config, like `user_profiles`). No server-side admin-group guard (consistent with existing `/admin/*`).

## Backend (`apps/backend`)

1. **Schema** — new file `src/db/schema/label-print.ts` (re-export from `src/db/schema/index.ts`):
   ```ts
   export const labelPrintRules = pgTable("label_print_rules", {
     id: text("id").primaryKey(),                       // UUID v7 via newId()
     name: text("name").notNull(),
     labelType: text("label_type").notNull(),
     conditions: jsonb("conditions").notNull(),         // shape above
     printTemplateId: text("print_template_id").notNull(),
     priority: integer("priority").notNull().default(100),
     active: boolean("active").notNull().default(true),
     remark: text("remark"),
     createdDate / lastUpdateDate                       // standard timestamps
   });
   ```
2. **Migration** — `pnpm --filter @warehouse/backend db:generate` → new `drizzle/00NN_*.sql`.
3. **Validation** — add to `src/routes/admin/crud.ts`: `optBool(b, key)` helper + a `reqConditions(b)` / `optConditions(b)` validator enforcing the JSON shape above (combinator ∈ and/or, ≥1 condition, allowed field/operator, non-empty value, numeric org_id), throwing `HTTPException(400)` with a clear message. Also a label-type check (`carton|item_box|item`).
4. **Routes** — mount in `src/routes/admin/index.ts`:
   `adminRoute.route("/label-print-rules", createCrudRouter({ table: labelPrintRules, pk, create, update }))` — standard GET/GET:id/POST/PATCH/DELETE. Default sort: `priority` asc, then `created_date`.
5. **No automated tests** — user will manually test the feature; verification is typecheck + nuxt prepare only (see below).

## Admin frontend (`apps/admin`)

6. **CrudForm extensions** (`components/CrudForm.vue` + `EntityField` in `utils/entities.ts`) — small reusable additions:
   - `boolean` type → checkbox; payload `true`/`false`.
   - `select` type → `SearchableSelect` with `:multiple="false"`, static `options: {value,label}[]` on the field config.
   - `conditions` type → renders the new structured editor component.
7. **New component** `components/RuleConditionsEditor.vue` — v-model over the conditions object: AND/OR segmented switch + condition rows (field dropdown, operator dropdown constrained per field — `org_id` offers `eq` only; others offer `eq`/`match` — value text input), add/remove row buttons. Draft-model style like `flow-config.vue`'s group editor, but as a reusable form field.
8. **Entity config** (`utils/entities.ts`): `labelPrintRules` — fields: `name` (text, required), `labelType` (select carton/item_box/item, required), `conditions` (conditions editor, required), `printTemplateId` (text, required, hint lists known template slugs), `priority` (number), `active` (boolean), `remark` (text). List columns show a compact conditions summary (e.g. `org_id = 2 AND customer = C001`) via field `format`, and `active` as a badge. Add nav link to `navSections` (Settings section).
9. **Page** `pages/label-print-rules.vue` — `<CrudTable :config="entities.labelPrintRules">` + `row-actions` slot Activate/Deactivate button (PATCH `{active: !row.active}` then `reload()`).
10. **i18n** — keys in all three locales `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`: `admin.entities.labelPrintRules.title`, `admin.navLinks.labelPrintRules`, `admin.fields.*` (`labelType`, `printTemplateId`, `active`, `priority`, `conditions`, `combinator`, operator/field labels, hints), `admin.pages.labelPrintRules.*` for editor strings.
11. **TOC.md** — add the page entry.

## Docs (per project workflow)

12. Spec: `docs/superpowers/specs/2026-09-16-label-print-rules-design.md` — the conditions JSON contract, glob semantics, priority/first-match-wins evaluation (so the later web picking printing work codes against it).
13. Plan: `docs/superpowers/plans/2026-09-16-label-print-rules.md`.
14. Update `docs/backend/api-design.md` (route catalog) and `docs/backend/schema-tables.md` (new table).
15. Update `docs/app-docs/ai/feature-registry.md` + `ai/code-map.md`.
16. One-line addition to the AGENTS.md "Printing" bullet mentioning the rules table + `/admin/label-print-rules`.

## Out of scope (later, user will provide templates)

- Web picking-flow printing logic that evaluates these rules.
- Print template management / template-list endpoint.

## Verification

1. `pnpm --filter @warehouse/backend build` (tsc typecheck).
2. `pnpm --filter @warehouse/admin exec nuxt prepare` (types generate cleanly).
3. Manual testing by the user (they will run the backend + admin and exercise the page themselves).

## Update 2026-09-16 — detail-page edit + picking-order match preview (implemented)

Increment: replace the edit dialog with a detail page — left 2/3 edit form,
right 1/3 a match-preview panel (keyword box matching `order_no`/`po_no` +
Test button querying which picking orders the **draft** conditions match; no
auto-refresh). Status: implemented 2026-09-16.

Condensed plan (executed):

1. **Backend evaluator** — new `apps/backend/src/db/labelPrint.ts`
   (`testLabelPrintRuleMatch(conditions, keyword?, limit?)` → `{rows, total}`;
   will later also serve the web picking printing flow). Condition → SQL
   mapping on `picking_orders po`: `org_id`/`sub_inventory`/`order_no`/
   `order_type`/`customer` → the matching column; `eq` → `=`, `match` →
   glob-to-LIKE (`*`→`%`, escaped literals — same semantics as
   `poNoGlobTest`); `supplier` → `EXISTS` over `picking_items` JOIN `parts`
   on `wcl_item_no` (order matches if ANY item's part brand matches);
   keyword → ILIKE on `order_no`/`po_no`; rows ordered by `priority_seq`,
   limit default 50 cap 200, `total` = COUNT(*) of all matches. Conditions
   validated with the existing validator (exported from
   `routes/admin/crud.ts`) → 400 on bad shape.
2. **Route** — new `apps/backend/src/routes/admin/labelPrintRules.ts` with
   `POST /test-match`, mounted alongside the existing CRUD at the same
   `/label-print-rules` prefix.
3. **Admin list page** — `entities.labelPrintRules` gained `noEdit: true`
   (keeps New dialog + Delete); row-actions gained an Edit `NuxtLink` to
   `/label-print-rules/:id` before the Activate/Deactivate toggle.
4. **Detail page** `apps/admin/pages/label-print-rules/[id].vue` — loads via
   `GET /admin/label-print-rules/:id`; `grid-template-columns: 2fr 1fr`;
   left: hand-built form (name, labelType single-select,
   `RuleConditionsEditor`, printTemplateId + hint, priority, active, remark),
   Save → PATCH with client-side conditions validation; right: preview panel
   posting draft conditions + keyword to `test-match`, showing total (with
   capped notice) + compact order table, empty/error states.
5. **i18n** — new `admin.pages.labelPrintRules.*` keys in all three locales.
6. **Docs** — spec + api-design.md + code-map.md + AGENTS.md printing bullet
   updated.

Verification: `pnpm --filter @warehouse/backend build` (tsc),
`nuxt prepare` for admin, manual testing by the user. Out of scope (still):
web picking-flow printing; create flow stays as the CrudTable dialog.
