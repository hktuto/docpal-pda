# Picking boxing: manual finish + box COO consistency + box contents (2026-10-16)

Operator feedback on the picking order detail page's "put item into box" flow
three changes, all PDA-first with backend enforcement where cross-order packing
makes client-side checks unreliable.

## 1. No auto-complete — explicit Finish

An order used to auto-finish the moment its last package was boxed (scan-into-box,
add-to-box, add-all, whole-box claim, box close). Operators had no chance to
review the boxes before the order disappeared from the picking list.

Change: **boxing never finishes an order.** The order stays `picking` until the
operator presses the **Finish** button on the order detail page
(`POST /picking-orders/:id/finish`, already exists). Consequences:

- `maybeAutoFinishPickingOrder` / `retryAutoFinishPickingOrder` are removed from
  `src/db/picking.ts`, including all call sites (scan, claim, add-to-box,
  add-all, close box). `finishPickingOrder` inlines the finish (status check
  `pending`/`picking`/`allocated`, all-items-boxed check, unresolved
  outdated-warning 409) and no longer delegates to the auto-finish helper.
- Admin outdated-warning resolution (`POST /admin/outdated-warnings/resolve-order`)
  no longer re-runs a picking finish — there is nothing to re-run. After
  resolution the operator's Finish (previously 409 `unresolved_outdated_warnings`)
  succeeds. Receiving auto-clear on resolve is unchanged.
- The PDA detail page keeps the header Finish action and adds a sticky footer
  Finish button shown when every item is fully boxed, so the confirmation step
  is visible where the operator just worked.

## 2. One COO per box (soft-enforced)

A shipping box should contain items of a single country of origin (COO).

- Single-package add-to-box (`POST /shipping-boxes/:id/packages`,
  `addPackageToBox`) and cross-order scan-into-box
  (`POST /shipping-boxes/:id/scan`, → `scanPickingItem` with a box): the backend
  rejects with 409 `box_coo_mismatch` when the box already holds packages with a
  non-null COO set and the incoming package's (non-null) COO is not in it.
  A null COO (label/source carried none) never conflicts.
- The PDA detail page enforces the same rule client-side before calling
  add-to-box (friendly toast, no round trip) and translates the backend 409 for
  the scan-into-box path using the box's locally-known contents.
- **Add-all is exempt**: `addAllUnboxedToShippingBox` packs everything as today.
  When the result mixes COOs the box card shows a ⚠ "Mixed COO" chip listing the
  distinct COOs so the operator can move items out (see §3). Whole-box claim
  (`claimShelfBox`) is likewise exempt — it packs one physical shelf box as-is.

## 3. Box contents on the box card

`PickingBoxesSection` box cards get a per-box expandable contents list:
each row shows the part (wcl item no / part no), qty, and the batch fields
(date code / lot code / COO / COW). Open boxes show a **Move out** button per
row (existing `DELETE /shipping-boxes/:id/packages/:packageId`,
`removePackageFromBox` — the package returns to the unboxed list, box must be
open). Contents are computed client-side from `order.items[].packages`
(`shippingBoxId` + batch fields — no API change).

The mixed-COO chip (distinct non-null COOs > 1) renders on the box card; a
single-COO box shows no chip.

## Non-goals

- No `shipping_box_items` mirror; `picking_packages.shipping_box_id` stays the
  boxing truth.
- No flow-config flag: auto-finish is removed outright, not made configurable.
- Measuring/verify flows are untouched (box-scoped, not order-scoped).

## Test/doc impact

- Backend tests that drove orders through auto-finish now call
  `finishPickingOrder` explicitly; outdated-warning tests assert the order stays
  open after resolve until the explicit finish. New tests: `box_coo_mismatch` 409 on
  add-to-box and scan-into-box, add-all with mixed COO allowed.
- Docs: `AGENTS.md`, `docs/backend/api-design.md`, `docs/app-docs/flows/picking/*`
  drop the auto-finish wording; picking item `picked_qty` still counts boxed
  packages only (that semantic is unchanged).
