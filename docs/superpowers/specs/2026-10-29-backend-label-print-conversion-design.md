# Backend label-print param conversion — design

Date: 2026-10-29
Status: proposed

## Problem

The labeling step (and the picking-finish print prompt) builds `printingParams`
for the print service on the PDA (`apps/pda/utils/labelPrintParams.ts` —
`buildLabelPrintParams(labelType, order)`), keyed only by `labelType`
(`carton` / `item_box` / `item`). Each row is a superset of all documented
template fields; canvas templates bind by name and ignore extras.

This breaks down when a template needs data the PDA does not have or should
not compute:

- derived fields that need other DB tables (parts master, supplier profiles,
  country list, customer name lookup, …) — the PDA only holds the order detail;
- A4 (`a4-canvas`) templates, which need `printingParams[].items[]` chunked to
  the template's slot count instead of flat label rows;
- customer-specific payload formats (QR strings, year/month splits, KOA-style
  date-code decoding).

Latent bug found while designing this: `getPickingOrderDetail`
(`apps/backend/src/db/picking.ts`) does not select the packages'
`scanned_date_code` / `scanned_lot_code` / `scanned_coo` / `scanned_cow`
columns, so the PDA builder's `pkg.scannedDateCode ?? pkg.dateCode` fallback
never sees the scanned values — labels always print the source snapshot, not
the physical label's batch fields.

## Decision

Move param conversion to the backend, dispatched **per `printTemplateId`**
with the current superset builder as the default fallback. The PDA sends only
`{ ruleId }`; the backend loads the rule, re-validates it against the order,
loads the order detail, converts, and proxies to the print service.

Why per-templateId (not per-rule): rules are admin data (conditions +
template pointer); the conversion shape is a property of the template. A rule
record stays data-only — no code/config column added.

Why backend (not PDA): converters may query other tables; one implementation
serves PDA and any future admin printing; the backend already owns
`resolveLabelPrintRulesForOrder` and the order detail loader.

## API

### `POST /picking-orders/:id/label-print`

Body: `{ ruleId: string }`.

Flow (route `apps/backend/src/routes/picking.ts`, domain
`apps/backend/src/db/labelPrintParams.ts`):

1. Load the rule from `label_print_rules` — 404 `label_print_rule_not_found`,
   409 `label_print_rule_inactive` when `active = false`.
2. Re-run `resolveLabelPrintRulesForOrder(db, orderId)` and require `ruleId`
   among the matches (rules may have been edited since the PDA fetched them)
   — 409 `label_rule_no_longer_matches`. This also 404s unknown orders.
3. Load the order detail via `getPickingOrderDetail` with the caller's user
   scope (same visibility as `GET /picking-orders/:id`).
4. Build params: converter registry lookup by the rule's `print_template_id`;
   no registered converter → the default superset builder keyed by
   `label_type`. Empty params → 400 `printing_params_required`.
5. `dynamicPrint({ templateId, printingParams, copies: 1, mode: "auto" })`
   (`src/print.ts`); upstream failure → 502 as today.
6. Return `{ jobs, labelCount }` (jobs = the print-service job list; the PDA
   polls `GET /print/jobs/:jobId` as today).

The generic `POST /print/dynamic` proxy stays for admin/direct printing.

### `GET /picking-orders/:id/label-print-rules` — add `labelCount`

Each match gains `labelCount: number` (the converted param-row count), because
the PDA panel shows the per-rule label count before printing and no longer
builds params client-side. Counts are computed in the route handler only —
`listLabelingOrders` keeps calling `resolveLabelPrintRulesForOrder` without
counts so the labeling list never pays converter cost per row.

## Backend module: `src/db/labelPrintParams.ts`

```ts
export interface LabelPrintContext {
  db: DbOrTx;
  order: PickingOrderDetail;   // from getPickingOrderDetail
  match: LabelPrintRuleMatch;  // ruleId, name, labelType, printTemplateId
}
type LabelParamConverter = (ctx: LabelPrintContext) => Promise<Record<string, unknown>[]>;

const converters: Record<string, LabelParamConverter> = {
  // per-templateId overrides registered here (A4 chunking, customer-specific
  // payloads, DB-enriched fields)
};

export async function buildLabelPrintParams(ctx): Promise<Record<string, unknown>[]>
export async function printOrderLabel(db, input: { orderId; ruleId; scope }): Promise<{ jobs; labelCount }>
```

- Default builder: a port of the PDA `buildLabelPrintParams` (identity / part /
  batch field supersets, `page`/`total`/`showTailBox` tail), keyed by
  `labelType`, operating on `PickingOrderDetail`.
- Batch fields anchor to the package's scanned values when present
  (`scannedDateCode ?? dateCode`, …) — requires the `getPickingOrderDetail`
  packages query to select the four `scanned_*` columns (fixes the latent
  bug); the PDA types already declare them optional, so the response shape is
  unchanged for other consumers.
- Converters receive `db` so they can enrich from other tables.

## PDA changes

- `services/types.ts`: `LabelPrintRuleMatch` gains `labelCount: number`.
- `services/warehouse.ts` + `adapters/backendWarehouse.ts`: add
  `printPickingLabel(orderId, ruleId): Promise<{ jobs: PrintJob[]; labelCount: number }>`
  → `POST /picking-orders/:id/label-print`.
- `components/picking/LabelPrintRulesPanel.vue`: drop the params cache and
  `buildLabelPrintParams`; the label count comes from `match.labelCount`;
  `printMatch` calls `printPickingLabel` then `waitForPrintJob` per job.
  Per-row state machine and print-all behavior unchanged.
- Delete `apps/pda/utils/labelPrintParams.ts` and
  `apps/pda/tests/labelPrintParams.test.ts` (the superset-builder tests move to
  a backend test alongside `src/db/labelPrint.test.ts`).
- `apps/pda/utils/print.ts`: remove `dynamicPrint` (unused after the move);
  keep `getPrintJob` / `waitForPrintJob`.

## Error semantics

| case | status | message |
| --- | --- | --- |
| unknown rule id | 404 | `label_print_rule_not_found` |
| rule inactive | 409 | `label_print_rule_inactive` |
| rule no longer matches the order | 409 | `label_rule_no_longer_matches` |
| unknown order / not visible | 404 | `picking_order_not_found` |
| converter produced no rows | 400 | `printing_params_required` |
| print service unreachable/error | 502 | `print service: …` (unchanged) |

## Non-goals

- No changes to `label_print_rules` schema or the admin rules UI.
- No printer selection (`printerName`) — the template's default printer keeps
  being used.
- The labeling list (`listLabelingOrders`) keeps its match count only.
