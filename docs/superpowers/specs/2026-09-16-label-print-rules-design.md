# Label print rules — design

Date: 2026-09-16
Status: implemented

## Problem

Different labels printed during picking (carton labels, item-box labels,
item labels) need different print templates depending on context — which
org/sub-inventory the order ships from, which supplier or customer is
involved, which order series. The mapping is per-warehouse business data,
not code, and it changes as customers onboard new templates. It needs to be
editable by admins without a deploy.

## Goal

Admin-managed rules that decide which print template to use when printing
labels during picking. Each rule = a flat AND/OR condition list + a label
type + a linked print template ID. Full CRUD + activate/deactivate in the
admin console, with a structured condition editor (no raw JSON typing).
This feature delivers the rule storage and admin surface only — the web
picking flow that evaluates the rules comes later and codes against the
contracts fixed here.

## Rule model

- **Flat AND/OR**: one list of conditions combined by a single combinator
  (`and` / `or`). A rule may use any subset of fields (e.g. just
  `org_id + customer`). No nesting, no grouping.
- **`label_type`** ∈ `carton | item_box | item` — which kind of label the
  rule applies to.
- **`print_template_id`** — free-text string = upstream print-service
  template slug (e.g. `katata-label`). No template-list API exists
  upstream, so the value is not validated against the print service; the
  admin form shows a hint with the known slugs from
  `docs/backend/print-service.md`.
- **`priority`** (integer, default 100) — evaluation order.
- **`active`** (boolean, default true) — inactive rules are skipped at
  evaluation time; the admin list has an Activate/Deactivate row action
  (PATCH `{active}`).
- **`remark`** — optional free-text note.

## Conditions JSON contract

Stored in a `conditions` jsonb column:

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

- `field` ∈ `org_id | sub_inventory | supplier | order_no | order_type | customer` (`order_type` = `picking_orders.picking_order_type`, an upstream-synced free-text value)
- `operator` ∈ `eq` | `match`
- `value`: non-empty string; for `org_id` the value must be numeric.
- At least 1 condition required.

### Operator semantics

- `eq` — exact match, full string, case-sensitive.
- `match` — **glob**: `*` matches any run of characters, every other
  character is literal — `319*` prefix, `*W` suffix, `*` catch-all. A
  plain string without `*` is therefore exact — the same convention as
  `receivingSubInventoryRules.poNoPattern`. Full-string, case-sensitive.

## Evaluation contract (for the later web picking flow)

When the web picking flow needs to print a label of a given
`label_type`:

1. Consider only **active** rules of that label type.
2. Iterate in **ascending `priority`** (ties broken by `created_date`
   ascending — the same order the admin list shows).
3. Evaluate each rule's conditions against the print context (order org /
   sub-inventory, supplier, order_no, customer); combine with the rule's
   combinator.
4. **First matching rule wins** — its `print_template_id` is used. No
   match = the flow falls back to its default template behavior (defined
   by the web-side work, not here).

## Backend surface

- New table `label_print_rules`
  (`apps/backend/src/db/schema/label-print.ts`, migration
  `drizzle/0011_fair_squadron_sinister.sql`): `id` text PK (UUID v7 via
  `newId()`), `name`, `label_type`, `conditions` jsonb,
  `print_template_id`, `priority` int default 100, `active` bool default
  true, `remark`, standard `created_date`/`last_update_date`. No
  `sync_events` trigger — admin-local config, like `user_profiles`.
- Standard CRUD mounted at `/admin/label-print-rules` via the generic
  `createCrudRouter` in `apps/backend/src/routes/admin/index.ts`:
  `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`; list sorted
  `priority` asc then `created_date` asc.
- Validators in `apps/backend/src/routes/admin/crud.ts`: `reqLabelType`
  (`carton|item_box|item`), `reqConditions`/`optConditions` (enforce the
  JSON contract above, 400 with a clear message on violation),
  `optBool`/`reqBool`. The conditions validation (`validateConditions`)
  and the `RuleCondition`/`RuleConditions` types are exported from
  `crud.ts` and shared with the test-match route.

## Test-match endpoint (draft-condition preview)

`POST /admin/label-print-rules/test-match`
(`apps/backend/src/routes/admin/labelPrintRules.ts`, mounted alongside the
CRUD router at the same prefix) evaluates a rule's **draft** conditions
against `picking_orders` so the admin edit page can preview which orders a
rule would match before saving.

- Body: `{ conditions, keyword?, limit? }` — `conditions` validated by the
  same `reqConditions` validator (400 on a bad shape); `keyword` optional
  string; `limit` optional int, default 50, capped at 200.
- Response: `{ rows: [{id, orderNo, poNo, customerCode, orgId,
  subInventoryCode, pickingOrderType, status}], total }` — rows ordered by
  `picking_orders.priority_seq` asc, truncated to `limit`; `total` = count
  of ALL matches (`COUNT(*) OVER ()`), so the UI can show "capped" when
  `total > rows.length`.
- `keyword` filters `(order_no ILIKE %kw% OR po_no ILIKE %kw%)` in
  addition to the condition predicates.

The evaluator lives in `apps/backend/src/db/labelPrint.ts`
(`testLabelPrintRuleMatch`) — this is the module the future web picking
printing flow will reuse for real rule evaluation.

### SQL evaluation mapping

Conditions map onto `picking_orders po`, combined with AND or OR per the
rule's combinator:

- `org_id` — eq → `po.org_id = n`; match → `po.org_id::text LIKE <glob>`.
- `sub_inventory` / `order_no` / `order_type` / `customer` — predicates on
  `po.sub_inventory_code` / `po.order_no` / `po.picking_order_type` /
  `po.customer_code`.
- `eq` → `=`; `match` → glob-to-LIKE (`*` → `%`, `%`/`_`/`\` escaped in
  literals, backslash LIKE escape) — full-string, case-sensitive, the same
  semantics as `poNoGlobTest` in `src/db/receiving.ts` (Postgres LIKE is
  implicitly full-string and case-sensitive).
- `supplier` — `EXISTS (SELECT 1 FROM picking_items pi JOIN parts p ON
  p.wcl_item_no = pi.part_no WHERE pi.picking_order_id = po.id AND
  p.brand <pred>)`: an order matches when ANY item's part brand matches
  (join on `wcl_item_no` per the convention in `src/db/picking.ts`).

## Admin console

- List page `apps/admin/pages/label-print-rules.vue` on the generic
  CrudTable, with an Edit `NuxtLink` to the detail page plus an
  Activate/Deactivate row action; nav entry in the Settings section
  (`apps/admin/TOC.md`). The entity config sets `noEdit: true` — the
  built-in CrudForm edit dialog is not used for editing (create still
  goes through the New dialog).
- Detail page `apps/admin/pages/label-print-rules/[id].vue` — 2fr/1fr
  grid: left the edit form (name, labelType via single-select
  `SearchableSelect`, `RuleConditionsEditor` for conditions,
  printTemplateId + hint, priority, active, remark; Save → PATCH), right
  a match-preview panel (keyword box matching order no / PO no + Test
  button posting the current draft conditions to `test-match`; results
  show `total` with a capped notice plus a compact order table; no
  auto-refresh — only the Test button queries).
- Entity config `entities.labelPrintRules` in
  `apps/admin/utils/entities.ts`; the list shows a compact conditions
  summary and an active badge.
- New reusable CrudForm field types (`apps/admin/components/CrudForm.vue`,
  `EntityField` gained `options`/`hint`/`defaultValue`): `boolean`
  (checkbox), `select` (single-select `SearchableSelect`), `conditions`
  (the structured editor).
- `apps/admin/components/RuleConditionsEditor.vue` — AND/OR switch +
  condition rows (field dropdown, operator dropdown constrained per field
  — `org_id` offers `eq` only, value input), add/remove rows.

## Out of scope

- **Web picking-flow printing** that evaluates these rules (codes against
  the evaluation contract above when it lands).
- **Print template management** — no template-list endpoint, no template
  CRUD; `print_template_id` stays free text.
