# Label source (internal/external) + label-aware verify — design

- Date: 2026-10-30
- Status: draft — two open decisions flagged "DECISION" below, chosen defaults await owner confirmation
- Builds on: `2026-10-27-picking-finish-label-print-prompt-design.md` (label print rules), `2026-10-28-picking-labeling-step-design.md` (labeling stage), `2026-10-29-backend-label-print-conversion-design.md` (backend print conversion + converters), `2026-10-03-picking-scan-truth-and-aggregate-verify-design.md` (aggregate verify)

## Background

Two gaps in the current labeling/verify chain:

1. **Label rules have no source dimension.** Some labels are not printed by us at
   all — the customer supplies them; we only hand the customer the order/scanned
   item details. Today every matched rule renders a print button on the PDA.
2. **Verify/measuring re-scans every picked package** (aggregate per part+batch,
   per-package `rescanned_qty` credits). This is wrong in both directions:
   - Orders with **no printed label** don't need per-package re-scan discipline —
     any scan/OCR combination that reaches each item's total qty should pass.
   - Orders with **printed labels** must additionally prove the right label was
     printed and stuck: a carton label opens the box for verify; item/item-box
     labels are each scanned together with the physical item, checking
     part_no/wcl_item_no, COO and date code between the two.

## Goals

1. `label_print_rules` gains a **label source**: `internal` (we print, today's
   behavior) | `external` (customer provides the label — no print button).
2. The backend **records every print** (reprints included): how many labels the
   order should print per matched rule, and the full converted content of each
   printed label, linked to the package/box it was generated for.
3. Verify/measuring splits per order into:
   - **Aggregate mode** (no internal label rule — including external-only orders):
     per-item totals list; scans credit the totals in any combination.
   - **Label mode** (≥ 1 internal rule matched): the recorded printed labels
     become verify requirements on top of the qty re-scan.

## Part 1 — label source

### Schema

`label_print_rules` new column (migration via `db:generate`):

- `label_source` text NOT NULL DEFAULT `'internal'`, CHECK IN
  (`'internal'`, `'external'`). Existing rows backfill to `'internal'` —
  behavior-preserving.

### Backend

- `resolveLabelPrintRulesForOrder` matches carry `labelSource`; first-match-per-
  label-type ordering is unchanged (source is not part of the match key — an
  external carton rule still blocks a lower-priority internal carton rule).
- `POST /picking-orders/:id/label-print` rejects an external rule with
  409 `label_rule_external`.
- The labeling-stage trigger (`finishPickingOrder`) and the box-holding gates
  treat internal and external matches the same: **an external-only order still
  enters labeling** — the operator must receive and stick the customer's labels,
  and "Finish labeling" is that attestation. DECISION (owner question 1, round
  1 — unanswered; defaulting to "external still holds the order").

### Admin

- `apps/admin/utils/entities.ts` label-print-rules entity + edit page: a
  `labelSource` select (`internal | external`), default internal. The match
  preview is unchanged.

### PDA

- `LabelPrintRulesPanel.vue`: external rows render as info rows — rule name,
  "label provided by customer" line, labelCount, **no print button**, never in
  `printAll`. `allPrinted` ignores external rows (they are not printable).

## Part 2 — print records

New table `label_prints` (migration via `db:generate`), one row per print
**action** (a reprint is a new row — full history):

- `id` text PK (`newId()`), `created_date`/`last_update_date` per convention.
- `picking_order_id` text NOT NULL → picking_orders.
- `rule_id` text NOT NULL → label_print_rules (no cascade delete — history
  survives rule edits; store `label_type` + `print_template_id` denormalized).
- `printer_name` / `service_id` / `device_key` text NULL — chosen printer.
- `expected_label_count` integer NOT NULL — converter row count at print time.
- `payload` jsonb NOT NULL — array of per-label rows:
  `{shippingBoxId: string|null, packageId: string|null, params: object}` where
  `params` is the exact `printingParams` row sent to the print service. Carton
  rows carry `shippingBoxId`; item/item_box rows carry `packageId`.
- `result` jsonb NULL — the print-service job ids/response.
- `printed_by` text NOT NULL (actor from JWT).

`printOrderLabel` (labelPrintParams.ts) inserts this row inside the same flow
after a successful upstream call; a failed upstream call records nothing.

Converters change shape: each converter row gains its linkage ref
(`packageId`/`shippingBoxId`) alongside the params — the default builders
already iterate per package / per box, so this is additive.

## Part 3 — verify/measuring rework

### Definitions

- An order is **labeled** when ≥ 1 **internal** active rule matched it at
  labeling time. Evaluated live per box load via
  `resolveLabelPrintRulesForOrder` filtered to `labelSource = 'internal'`.
- External-only and rule-less orders are **unlabeled** → aggregate mode.
  (Owner answer 3: external-only counts as no-label for verify.)
- A box can span orders (`shipping_boxes.picking_order_id` is informational);
  mode is therefore **per package**, not per box: packages of labeled orders
  follow label mode, the rest aggregate. The UI groups the two kinds.

### Aggregate mode (unlabeled orders)

- The verify/measuring list shows **one row per item** (part identity =
  wcl_item_no/part_no) with the **total qty** to re-scan, instead of per-package
  rows. Batch columns (date code/COO) show the distinct values in the group.
- Scanning is unchanged mechanically — `matchAggregatePackages` already credits
  any part+batch scan against group remaining with FIFO partial credits across
  the group's packages — so "any combination to the total" works today; the
  change is presentation (grouped rows) plus completion phrasing
  (per-item totals reached ⇔ every package `rescanned_qty >= qty`, identical).
- Batch soft-compare (compare only when both sides carry a value) stays.
  DECISION: keep today's strictness — "total qty must match" does not relax
  part/batch matching.

### Label mode (labeled orders)

Requirements stack **on top of** the qty re-scan (item scans still credit
`rescanned_qty` as today):

**Carton labels (entry control).**

- The verify list scan handler and the measuring box-open path first try the
  raw scan as a **printed carton label**: new endpoint
  `GET /verify-tasks/lookup-by-label?raw=` matches the raw string against the
  recorded carton print rows (`label_prints.payload` where `label_type =
  'carton'`) for open/pending boxes — a hit on any code field of a row's params
  (`barcode`, `qrcode1`, `qrcode2`, … any string value equality) resolves the
  box and opens its verify screen; a miss falls through to today's box-id
  matching.
- Opening a box this way stamps `shipping_boxes.carton_label_verified =
  true` (+`_at`/`_by`). A box with carton print records may also be opened
  from the list (not everyone will scan the label), but completion then still
  requires the carton label scan — the verify screen shows it as a pending
  requirement row. DECISION: entry-via-label is a convenience, not a hard gate;
  the hard gate is at completion.

**Item / item-box labels.**

- Each package of a labeled order shows a label-verification state:
  `label scanned? → item verified?`.
- Scanning a **printed label**: the raw scan is matched against recorded print
  rows for that order's item/item_box labels (same any-code-field equality).
  A hit marks the linked package `label_verified = true` (+`_at`/`_by`,
  new nullable columns on `picking_packages`) and returns the label's anchored
  expectations (part identity, COO, date code, qty) to the PDA.
- Scanning the **item itself** for a label-verified package: the normal
  aggregate matcher runs, plus a **hard batch compare** against the label
  record — part_no/wcl_item_no must match, and COO + date code must equal the
  label's values (mismatch → rejected scan with a per-field diff shown).
  Owner answer 1: exactly these three fields are checked between label and
  item.
- A package whose label was never printed (no print row) falls back to plain
  aggregate matching — you can't verify a label that doesn't exist; the row
  shows a "no printed label" hint instead of blocking completion.

### Completion

`completeVerifyTask` gains, for boxes containing labeled-order packages:

- 409 `labels_not_all_verified` unless every package with an item/item_box
  print record has `label_verified = true`, and every carton print record for
  the box is covered by `shipping_boxes.carton_label_verified`.
- The existing `packages_not_all_rescanned` qty gate is unchanged.

`reopenShippingBox` resets `label_verified` / `carton_label_verified` together
with the existing flag/credit resets.

## API changes

- `GET /picking-orders/:id/label-print-rules` — matches carry `labelSource`.
- `POST /picking-orders/:id/label-print` — 409 `label_rule_external`; writes
  `label_prints` on success.
- `GET /verify-tasks/:id` (+ `GET /measuring-boxes/:id`) — per-package
  `labelMode` (bool), `labelVerified`, label expectations when scanned; box
  `cartonLabelRequired`/`cartonLabelVerified`; grouped aggregate rows are
  client-side from the same package list.
- `POST /verify-tasks/:id/scan-label` `{raw}` — label-mode label scan:
  200 `{kind: 'carton'|'item', packageId?, expectations}` on match,
  404 `label_print_not_found` otherwise. Idempotent re-scans return the
  current state.
- `GET /verify-tasks/lookup-by-label?raw=` — box resolution by carton label.
- `POST /packages/:id/verify` — unchanged signature; label mode adds the hard
  COO/date-code compare server-side when the package is `label_verified`
  (409 `label_item_mismatch` with the differing fields), so a PDA-side bypass
  is impossible.

## PDA changes

- `LabelPrintRulesPanel.vue` — external info rows (Part 1).
- `MeasureBox.vue` — two sections: **items to re-scan** (aggregate per-item
  totals rows for unlabeled packages) and **labels to verify** (per-package
  label rows with scan-label → scan-item flow). Scan dispatch: try label match
  first (labeled boxes), then aggregate matcher.
- `pages/verify/index.vue` scan handler — carton-label lookup before box-id
  matching.
- i18n keys in `layers/i18n` for all new strings.

## Admin changes

- Rule form: `labelSource` select (Part 1).
- Order detail: read-only print history from `label_prints` (count + time per
  print action) — small; deferred if it balloons, not required for verify.

## Non-goals

- No customer-facing export of "order detail of scanned items" for external
  labels (handled outside the system for now; the recorded `label_prints`
  equivalent for external rules can come later).
- No enforcement that printing happened before "Finish labeling" (unchanged
  from the labeling-step spec: marking done is an operator attestation; verify
  simply falls back to aggregate for unprinted packages).
- No change to scan-template parsing — printed-label matching is raw-string
  equality against recorded params, template-agnostic.
- Measuring weights/size capture flow unchanged.

## Open decisions (defaults chosen, pending owner confirmation)

1. External-only orders still enter the labeling stage (default: yes).
2. Box completion requires the carton label scan even when the box was opened
   from the list (default: yes).
3. Unprinted packages of labeled orders fall back to aggregate matching instead
   of blocking (default: fallback).

## Testing

- Backend: node:test — external rule rejection, label_prints recording on
  print/reprint, lookup-by-label resolution, scan-label match/mismatch,
  label_item_mismatch compare, completion gating, reopen resets.
- PDA: vitest — aggregate grouping, label-mode dispatch order, external rows.
- Manual: full chain on 192.168.6.99 with the yhft-ch-01 order (2 boxes →
  carton entry + per-label item checks) and a no-label order (totals-only
  verify).
