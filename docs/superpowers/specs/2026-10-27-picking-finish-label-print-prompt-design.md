# Picking-finish label print prompt — design

Status: DRAFT (pending review — not implemented)
Date: 2026-10-27

## Summary

After the operator finishes a picking order on the PDA (the explicit
`POST /picking-orders/:id/finish`), the backend evaluates the order against
the active `label_print_rules` (spec
`2026-09-16-label-print-rules-design.md` — storage + admin surface only, which
explicitly deferred this web-side evaluation). When one or more rules match,
the PDA prompts the operator to print the corresponding labels — several
matches are possible — via the existing `/print/*` proxy to the label
printing center.

## Contracts fixed by the earlier spec (unchanged)

- Rule matching context is **order-level**: `org_id`, `sub_inventory`,
  `order_no`, `order_type`, `customer`, `supplier` (any item brand).
  Operators: `eq` (exact, case-sensitive) and `match` (glob, `*` wildcard,
  full-string).
- Evaluation contract: only **active** rules, ascending `priority` (ties →
  `created_date` asc, the admin list order); conditions combine per the
  rule's `combinator` (`and`/`or`).
- A rule's output is only `print_template_id` (+ `label_type` ∈
  `carton | item_box | item`). No printer field — omitting `printerName` in
  `POST /print/dynamic` falls back to the template's default printer.

## Design

### 1. Backend: rule resolution endpoint

New function `resolveLabelPrintRulesForOrder(db, orderId)` in
`apps/backend/src/db/labelPrint.ts`:

1. Load the order context once: `orgId`, `subInventoryCode`, `orderNo`,
   `pickingOrderType`, `customerCode`, plus the distinct set of item brands
   (`picking_items.part_no → parts.wcl_item_no → parts.brand`).
2. Load all active rules ordered `priority ASC, created_date ASC`.
3. Evaluate each rule's conditions in JS against the context (`eq`/`match`
   semantics shared with the SQL preview evaluator — extract the glob
   matcher into a helper both use; `supplier` matches when the glob/eq hits
   ANY brand in the set).
4. **First match wins per `label_type`** (the 2026-09-16 contract), so the
   result is up to one match per label type:

   ```json
   { "matches": [
     { "ruleId": "…", "name": "…", "labelType": "carton",
       "printTemplateId": "carton-label-canvas" } ] }
   ```

New route: `GET /picking-orders/:id/label-print-rules` (regular
authenticated route, not admin) → `{matches}`. Empty `matches` when nothing
matches — the PDA then skips the prompt entirely.

`testLabelPrintRuleMatch` (admin preview) stays as-is: it *finds orders* for
a draft rule; this is the reverse direction (rules for one order).

### 2. PDA: print client

New `apps/pda/utils/print.ts` mirroring `apps/admin/utils/print.ts`:
`listPrinters()`, `dynamicPrint({templateId, printingParams, copies?})`,
`waitForPrintJob(jobId)` — thin wrappers over the backend `/print/*` proxy
via `services/apiClient.ts`. (The dead `getLabelsData()` service method and
`LabelsData` type are removed in the same change — nothing calls them.)

### 3. printingParams mapping

`POST /print/dynamic` takes `printingParams: Record<string, unknown>[]` —
one label per row. A new mapping module
`apps/pda/utils/labelPrintParams.ts` builds the rows per matched rule:

| `label_type` | one row per | data source |
|---|---|---|
| `carton` | shipping box of the order | `shipping_boxes` + its packages |
| `item_box` / `item` | package of the order | `picking_packages` + item/order fields |

The per-template field mapping (which keys each `templateId` expects) is
defined in a per-template builder table keyed by template id, from the
catalog in `docs/backend/print-service.md` (e.g. `carton-label-canvas`:
`ATICode/MFRCode/orderNo/qty/serialNo/qrcode`). Templates without a known
builder are reported as unsupported in the prompt (not silently mis-printed).

The order detail payload (`GET /picking-orders/:id` — items, packages,
boxes) already carries everything needed; no new backend read.

**Open point for review (Q2):** which concrete templates/label types are in
scope for v1, and the exact field mapping for each.

### 4. Prompt UX (PDA)

In `pages/picking/unified/[id].vue`'s finish handler (and the legacy
`picking/[id].vue`), after a successful finish:

1. `GET /picking-orders/:id/label-print-rules`.
2. No matches → today's behavior (incl. the measuring-off → `/verify`
   navigation).
3. Matches → a modal (`components/picking/LabelPrintPrompt.vue`) listing
   every match: rule name, label type, template id, label count (boxes /
   packages). Actions per match: **Print** (spinner → job polling →
   success/error toast per print), plus **Print all** and **Skip**.
4. Skip / close proceeds to the normal post-finish flow. Printing never
   blocks the finish itself (the order is already finished server-side);
   print errors (502 upstream, failed job) surface as toasts only.

Printer selection: none in v1 — `printerName` omitted, the print service
uses the template's default printer (**open point Q3**).

### 5. Re-entry

The prompt also opens from the picking detail page (a header action "Print
labels", visible when the order is `picking_finished`/`measuring_finished`)
so labels can be re-printed without re-finishing.

## Out of scope

- Admin-side printing and rule management (already shipped).
- Printer picker UI, copies editing (v1: one label per box/package).
- Print-on-scan or print-on-box-close triggers.
- New rule condition fields (package-level conditions).

## Open questions for review

- **Q1 — multiplicity.** First-match-wins **per label type** (the fixed
  contract) means at most 3 prints. Is that the intent, or should ALL
  matching rules print (potentially several templates of the same type)?
- **Q2 — template scope.** Which `print_template_id`s must v1 support, and
  what is the exact field mapping for each (from
  `docs/backend/print-service.md`)?
- **Q3 — printer.** Template default printer OK, or does the operator need
  to pick a printer on the PDA (`GET /print/printers`)?
- **Q4 — timing.** Prompt immediately after finish (boxes/packages are
  final by then), or only after the measuring close / verify completion?

## Test plan

- Backend: `resolveLabelPrintRulesForOrder` unit tests over seeded orders +
  crafted rules (per-type first-match-wins, combinator and/or, glob `match`
  vs `eq`, supplier brand set, inactive rules skipped); route test for
  `GET /picking-orders/:id/label-print-rules` (404 unknown order, empty
  matches).
- PDA (vitest): `labelPrintParams` builders per supported template; prompt
  visibility logic (no matches → no prompt; finish error → no prompt).
- Manual: seed a rule matching a demo order, finish it on the PDA, confirm
  the prompt and a real print job against the print service.
