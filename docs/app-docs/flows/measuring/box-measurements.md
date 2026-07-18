# Box Measurements

Each shipping box must have its measurements recorded before it can be
closed and the measuring task completed.

## Required fields

- **Box size** — the box type/size code.
- **Net weight** — weight of the contents, in grams.
- **Gross weight** — total weight of the packed box, in grams (must be at
  least the net weight).
- **Destination country** — falls back to the picking order's destination
  when left unset.

## How to enter

1. Open the box page from the measuring task detail.
2. Tap the measurements action to open the `BoxMeasurementsModal`.
3. Enter the box size and weights (integer grams) and save.

## Validation

Weights must be positive integers; the gross weight must be greater than or
equal to the net weight. The backend enforces this when the box is closed
(`weights_required`, `weights_must_be_positive`,
`gross_weight_must_be_gte_net_weight`).

## Related components

- `components/BoxMeasurementsModal.vue`
