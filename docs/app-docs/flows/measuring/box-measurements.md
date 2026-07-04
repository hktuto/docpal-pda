# Box Measurements

Each shipping box must have its dimensions and weight recorded before the measuring task is finished.

## Required fields

- **Length** — longest side of the box.
- **Width** — second side.
- **Height** — remaining side.
- **Weight** — total weight of the packed box.

## How to enter

1. Open the box detail or the `BoxMeasurementsModal`.
2. Enter each dimension.
3. Save.

## Validation

The demo may apply simple validation (positive numbers, reasonable ranges). The exact rules are defined in `db/measuring.ts` and the measuring page components.

## Related components

- `components/BoxMeasurementsModal.vue`
