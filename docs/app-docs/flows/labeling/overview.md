# Labeling (待貼標籤)

## Purpose

Labeling is an optional stage **between label printing (or picking finish)
and measuring/verify** for picking orders that need labels stuck on the goods
(carton / item box / item labels per the admin-configured label print rules).
It is the second of the two label stages (spec 2026-11-02): the printing duty
lives in [Label Printing](../label-printing/overview.md); this stage is the
sticking duty — finishing attests the labels are on.

## Entry point

Home tile → **Labeling / 待貼標籤** (`/labeling`), between Label Printing and
Measuring. Hidden when the `labeling` flow step is disabled.

## Key concepts

- **When an order enters the queue** — at label-printing finish when the
  `label-printing` step applied, or directly at picking finish when it did not
  (printing step disabled, or no **internal** rule matched) — provided the
  `labeling` flow step is enabled AND the order matches at least one active
  [label print rule](../../admin-user-menu/index.md) of any source
  (external-only orders still enter labeling; finishing attests the customer's
  labels are stuck). Orders matching no rule skip the stage entirely.
- **Boxes are held back** — while an order is pending labeling, its shipping
  boxes do not appear in the Measuring list, and (when the measuring step is
  off) its verify tasks are not created yet. A cross-order box waits until
  ALL its orders have cleared labeling.
- **Print and confirm** — open the order from the queue, (re-)print the matched
  labels if needed (same print UI as the picking-finish prompt), then tap
  **Finish labeling**. Nothing is enforced about actual printing — finishing
  is the operator's attestation that the labels are on. Routine printing
  belongs to the upstream Label Printing stage; this panel stays for
  reprints/external info.
- **Snapshot membership, live print list** — queue membership is decided at
  the stage entry (picking finish or label-printing finish; later rule edits
  don't move orders in/out), but the detail
  page re-evaluates the rules live for the print list; if the rules no longer
  match, the page says so and the operator just finishes.
- **Reprints after the stage** — the "Print labels" action on the picking
  detail page stays available after labeling is done.
- **External labels** — a rule marked *external* means the customer provides
  the label: the row shows "label provided by customer" with NO print button
  (the order still enters the queue; finishing attests the customer's labels
  are on). Only *internal* rules print.
- **Every print is recorded** — the backend stores each print (reprints
  included) with its full label content, which the Verify flow later uses to
  check scanned labels (see [Verify](../verify/overview.md)).

## Related flows

- [Label Printing](../label-printing/overview.md) — the preceding stage (printing)
- [Picking](../picking/overview.md) — the finish that queues the order when no printing stage applies
- [Measuring](../measuring/overview.md) — held until labeling clears
- [Verify](../verify/overview.md) — verify-task creation held until labeling clears
