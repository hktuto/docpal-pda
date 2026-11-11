# Packaging (打包)

## Purpose

Packaging is the **opt-in stage between verify and shipping** (spec
`docs/superpowers/specs/2026-11-10-packaging-shipping-steps-design.md`, CN
warehouses). Once an order's goods are fully boxed and verified, an operator
records the shipment's **total weight** plus either the **box count** (auto —
recomputed server-side, so it can never be typed wrong) or a **pallet count**,
and confirms once. It is an attestation of what the shipment weighs and how it
is packed — no stock moves.

## Entry point

Home tile → **Packaging / 打包** (`/packaging`), between Verify and Shipping.
Hidden when the `packaging` flow step is disabled (default — enable per
warehouse on the admin flow-config page). The same queue + form also exist on
the admin console (`/packaging`).

## Key concepts

- **Order-keyed, once per order** — packaging is done for the whole picking
  order (all its boxes together), not per box. One confirm per order.
- **The queue is derived, never created** — an order appears when it is
  picking-complete, no labeling stages are pending, every package is boxed,
  every box holding its packages is closed (+ its verify task completed when
  the verify step is on) and it has never been packaged. Nothing to miss: a
  box reopened or a late verify completion moves the order back out.
- **Auto box count** — the detail page shows the current box count; at confirm
  the server counts again and stores THAT number. The typed value never wins.
- **Boxes or pallets** — the default mode is "by boxes" (the auto count).
  Switching to "by pallets" adds a pallet-count field (≥ 1); the box count is
  still recorded next to it.
- **Weight is a scale reading** — the total weight (kg, ≤ 3 decimals) is typed,
  independent of the summed per-box gross weights, which are shown as a hint
  only.
- **Cross-order boxes wait for everyone** — a box holding packages from two
  orders appears in BOTH orders' packaging views; while the packaging step is on
  it only ships once every non-cancelled order inside it is packaged.
- **Confirmed = shipped-ready gate** — packaging confirmation is what releases
  the order's boxes into the admin shipping feed (寄出 review), where the
  weight/box/pallet numbers are copied into the delivery provider's form.

## Related flows

- [Verify](../verify/overview.md) — the preceding stage whose completion queues packaging
- [Shipping (admin)](../../../admin/TOC.md) — the per-box ship feed + packaging review (admin console; 寄出 is admin-only)
