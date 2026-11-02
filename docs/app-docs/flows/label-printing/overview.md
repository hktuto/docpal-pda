# Label Printing (打印標籤)

## Purpose

Label printing is the first of the two label stages between picking finish
and measuring/verify (spec 2026-11-02). It covers the **printing** duty only:
a queue of finished picking orders whose internal label print rules matched,
so one operator can print everything at the printer bench while another sticks
labels on the floor in the follow-up [Labeling](../labeling/overview.md) stage.

## Entry point

Home tile → **Label Printing / 打印標籤** (`/label-printing`), between Picking
and Labeling. Hidden when the `label-printing` flow step is disabled.

## Key concepts

- **When an order enters the queue** — at picking finish, when the
  `label-printing` flow step is enabled AND the order matches at least one
  active **internal** label print rule (first match per label type). External
  labels are provided by the customer and never printed by us, so
  external-only orders skip this stage and enter labeling directly.
- **Boxes are held back** — same as labeling: while an order is pending label
  printing, its boxes stay out of Measuring and (when the measuring step is
  off) its verify tasks are not created yet.
- **Print and confirm** — open the order from the queue, print the matched
  labels (re-printable, same print UI as the labeling detail and the
  picking-finish prompt), then tap **Finish printing**. Nothing is enforced
  about actual printing — finishing is the operator's attestation.
- **Finishing moves the order on** — with the `labeling` step enabled the
  order joins the labeling queue (guaranteed by the finish-time snapshot, even
  if the rules were edited since); with labeling disabled the order advances
  straight to measuring/verify.
- **Snapshot membership, live print list** — queue membership is decided at
  picking finish; the detail page re-evaluates the rules live for the print
  list and says so when they no longer match (the finish action stays).
- **Every print is recorded** — the backend stores each print (reprints
  included) with its full label content, which the Verify flow later uses to
  check scanned labels (see [Verify](../verify/overview.md)).

## Related flows

- [Picking](../picking/overview.md) — the finish that queues the order
- [Labeling](../labeling/overview.md) — the follow-up stage (sticking labels)
- [Measuring](../measuring/overview.md) — held until both label stages clear
- [Verify](../verify/overview.md) — verify-task creation held until both label stages clear
