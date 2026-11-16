# Packaging — Operator Steps (PDA)

## 1. Open Packaging

From the home screen, tap **Packaging / 打包**. The list shows orders whose
goods are fully boxed and verified but not yet packaged, newest first. Each
row shows the order number, customer/ship-to, and a chip with the box count.
(The tile only appears when the warehouse enables the `packaging` flow step.)

## 2. Open the order

Tap a row. The detail shows the order header (customer, ship-to) and the box
summary: how many boxes were scanned and how many packages they hold. That
box count is the **auto** number from the scan records — it is shown for
reference and can never be typed over.

## 3. Choose the input mode and record the shipment

The form has two modes (spec `2026-11-16-packaging-box-cart-modes-design.md`):

- **按箱 (by box)** — type the **box count (打包記錄)** of the packaging record
  (whole number ≥ 1 — it may differ from the scanned count, e.g. after
  repacking) and the **total weight (kg)** read off the scale. The scanned box
  count stays displayed as the reference.
- **按卡板 (by cart)** — one row per cart, auto-numbered 卡板 1, 卡板 2, ….
  Each row takes its own **box count** and **weight**; add rows with
  **+ 添加卡板**, remove with ✕ (at least one row). The totals line shows the
  running sums (carts · boxes · kg) — the server re-derives them at confirm.

## 4. Confirm

Tap **Confirm packaging / 確認打包** and accept the confirmation prompt. One
confirm per order — the order then leaves this list and its boxes move into
the admin shipping (寄出) feed. If another operator already confirmed it, the
app says so and returns to the list. Packaged orders cannot be re-confirmed
from the PDA — the recorded numbers are final unless an admin reworks the
order.

Packaged orders that were already confirmed show the recorded numbers instead
of the form: the total weight, the packing-record box count next to the
scanned (auto) count, and — in cart mode — each cart's box count and weight.
