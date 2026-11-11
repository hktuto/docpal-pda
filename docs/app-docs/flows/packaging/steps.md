# Packaging — Operator Steps (PDA)

## 1. Open Packaging

From the home screen, tap **Packaging / 打包**. The list shows orders whose
goods are fully boxed and verified but not yet packaged, newest first. Each
row shows the order number, customer/ship-to, and a chip with the box count.
(The tile only appears when the warehouse enables the `packaging` flow step.)

## 2. Open the order

Tap a row. The detail shows the order header (customer, ship-to) and the
box summary: how many boxes, how many packages, and each box's package count
and gross weight. The box count is the **auto** number — do not count cartons.

## 3. Record the shipment

- **Total weight (kg)** — read it off the scale and type it in (decimals
  allowed, e.g. `12.345`).
- **Boxes or pallets** — the default mode is **by boxes**, which keeps the
  auto box count. Switch to **by pallets** (按卡板) when the shipment rides
  on pallets, and type the pallet count (whole number ≥ 1). The box count is
  still recorded either way.

## 4. Confirm

Tap **Confirm packaging / 確認打包** and accept the confirmation prompt. One
confirm per order — the order then leaves this list and its boxes move into
the admin shipping (寄出) feed. If another operator already confirmed it, the
app says so and returns to the list. Packaged orders cannot be re-confirmed
from the PDA — the recorded numbers are final unless an admin reworks the
order.

Packaged orders that were already confirmed show the recorded numbers
(weight, boxes, pallets, who/when) instead of the form.
