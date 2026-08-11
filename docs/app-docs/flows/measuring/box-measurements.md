# Box Measurements

Each shipping box must have its measurements recorded before it can be
closed. Closing the box completes its measuring — no separate task or
complete step exists.

## Required fields

- **Box size** — the box type/size code.
- **Net weight** — weight of the contents, in **kilograms** (decimals
  allowed). Pre-filled with the auto-calculated value from the part
  net-weight master (`net_weight_formula`) when the box's parts have one —
  adjust it if the scale disagrees.
- **Gross weight** — total weight of the packed box, in **kilograms** (must
  be at least the net weight).
- **Destination country** — falls back to the box's creator order's ship-to
  when left unset.

## How to enter

1. Open the box page from the measuring list.
2. Tap the measurements action to open the `BoxMeasurementsModal`.
3. Enter the box size and weights (kg, up to 3 decimals) and tap
   **Confirm box** — one action that saves the measurements and closes the
   box.

## Validation

Weights must be positive numbers; the gross weight must be greater than or
equal to the net weight. The backend enforces this when the box is closed
(`weights_required`, `weights_must_be_positive`,
`gross_weight_must_be_gte_net_weight`) and rejects non-numeric input on the
update (`invalid_net_weight_kg`, `invalid_gross_weight_kg`).

## Related components

- `components/BoxMeasurementsModal.vue`
