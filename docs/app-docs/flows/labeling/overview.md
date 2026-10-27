# Labeling (待貼標籤)

## Purpose

Labeling is an optional stage **between picking finish and measuring/verify**
for picking orders that need printed labels (carton / item box / item labels
per the admin-configured label print rules). It gives operators a task queue of
finished orders still waiting for their labels, instead of relying on the
one-shot print prompt shown at picking finish.

## Entry point

Home tile → **Labeling / 待貼標籤** (`/labeling`), between Picking and
Measuring. Hidden when the `labeling` flow step is disabled.

## Key concepts

- **When an order enters the queue** — at picking finish, when the `labeling`
  flow step is enabled AND the order matches at least one active
  [label print rule](../../admin-user-menu/index.md) (first match per label
  type). Orders matching no rule skip the stage entirely.
- **Boxes are held back** — while an order is pending labeling, its shipping
  boxes do not appear in the Measuring list, and (when the measuring step is
  off) its verify tasks are not created yet. A cross-order box waits until
  ALL its orders have cleared labeling.
- **Print and confirm** — open the order from the queue, print the matched
  labels (re-printable, same print UI as the picking-finish prompt), then tap
  **Finish labeling**. Nothing is enforced about actual printing — finishing
  is the operator's attestation that the labels are on.
- **Snapshot membership, live print list** — queue membership is decided at
  picking finish (later rule edits don't move orders in/out), but the detail
  page re-evaluates the rules live for the print list; if the rules no longer
  match, the page says so and the operator just finishes.
- **Reprints after the stage** — the "Print labels" action on the picking
  detail page stays available after labeling is done.

## Related flows

- [Picking](../picking/overview.md) — the finish that queues the order
- [Measuring](../measuring/overview.md) — held until labeling clears
- [Verify](../verify/overview.md) — verify-task creation held until labeling clears
