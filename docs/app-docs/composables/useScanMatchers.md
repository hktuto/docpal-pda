# useScanMatchers

`composables/useScanMatchers.ts`

Validates parsed label data client-side for the picking, put-away, and
measuring scan flows. (Receiving scans are matched server-side — see
`composables/useReceivingScan.ts`.)

## When to use

Use this composable when implementing a scan flow that validates a scanned
label against a pre-selected target before applying a write:

- **Picking** — the scanned part/qty must fit the pre-selected allocation
  row; apply calls `WarehouseService.scanPickingItem`.
- **Put-away** — the scanned part/qty must fit the pinned expected item;
  apply calls `WarehouseService.recordPutAwayScan`.
- **Measuring** — the label must match an unverified package in the box
  (batch fields constrain only when both sides carry a value; qty must be
  exact); apply calls `WarehouseService.verifyPackage`.

## Main responsibilities

- Compare parsed fields to the target record (normalized text).
- Return a single match with an `apply()` action, or a `none`/`error`
  result for the review modal.
- Translate `I18nError` codes into localized messages.

## Related files

- `composables/useLabelScan.ts`
- `composables/useReceivingScan.ts` — receiving's server-side counterpart.
- `composables/useWarehouse.ts` — write actions (scan pick, record put-away
  scan, verify package) routed to `apps/backend`.
- `services/types.ts` — shared DTOs (`PutAwayExpectedItem`,
  `MeasuringPackage`).

## Architecture note

Only validation runs client-side. All writes go through `WarehouseService`
to `apps/backend` (:3002), where the transaction logic, invariants, and
ledger rows live.
