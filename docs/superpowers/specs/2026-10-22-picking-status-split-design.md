# Picking order status split: `finished` → `picking_finished` + `measuring_finished`

Date: 2026-10-22
Status: implemented

## Background

The picking order lifecycle used a single `finished` status for both "all items
picked and boxed" (operator presses Finish on the PDA) and "measuring/verify
pass complete" (a downstream stage with its own queue). Operators and admins
could not tell from the list whether an order still owes measuring work.

## New lifecycle

```
pending → allocated → picking → picking_finished → measuring_finished → shipped
                    ↘ issue → pending (resolve)      ↗ (admin override any→any)
                    ↘ skip                           (status override, any→any)
```

- `pending` — synced demand, not yet picked.
- `allocated` — admin-confirmed allocation lock (out of `loadDemands`, allocation
  rows survive recompute).
- `picking` — first item scan flips pending/allocated → picking.
- `picking_finished` — **operator Finish** (`POST /picking-orders/:id/finish`,
  `finishPickingOrder`). All items fully boxed. Replaces the old `finished`.
- `measuring_finished` — **the order's last pending verify task completes**
  (`completeVerifyTask`): when no other `pending` verify task remains for any of
  the orders touching the task's box, each such order still in
  `picking_finished` flips to `measuring_finished`.
- `shipped` — derived by `shipShippingBox` as today (all items boxed, nothing
  unboxed, no package in an unshipped box); accepts source orders in either
  `picking_finished` or `measuring_finished`.
- `issue` / `skip` — unchanged.
- Admin status override (`PATCH /admin/picking-orders/:id/status`) stays any→any
  over the full set.

`finished` is removed from the application-level status set
(`PICKING_ORDER_STATUSES`). The column stays plain `text` (no CHECK constraint
exists); a migration backfills existing rows:
`UPDATE picking_orders SET status='picking_finished' WHERE status='finished'`.

## Transition points (single writers)

- → `picking_finished`: `finishPickingOrder` (`apps/backend/src/db/picking.ts`) —
  the only path; the unresolved-outdated-warnings 409 hold moves with it
  (measuring completion is NOT separately held).
- → `measuring_finished`: `completeVerifyTask` (`apps/backend/src/db/verify.ts`),
  inside the same tx, after the task row is marked completed. Related orders =
  orders with packages in the task's box. Orders already `shipped` are skipped.
- → `shipped`: `shipShippingBox` (`apps/backend/src/db/shipping.ts`).

Every transition keeps writing `transaction_logs` `fromState`/`toState` rows.

## Semantics that follow the split

- **Allocation**: holding statuses stay `{pending, picking, allocated}`; both
  new finishes are non-holding (their allocations were released at finish, and
  the admin override release rule for leaving a holding status is unchanged).
- **Measuring queue** (`listMeasuringBoxes`): a box qualifies once all its
  orders are in `('picking_finished','measuring_finished','shipped')` — an
  order owes measuring work only when it is `picking_finished`, and reappears
  in the queue if a box is reopened after measuring finished.
- **Writability** (`assertOrderWritable`): `picking_finished` /
  `measuring_finished` both 409 `picking_order_already_finished` (scan, finish,
  issue-report paths).
- **Cross-order scan scope** (`picking.ts` box-scan `IN ('pending','picking',
  'allocated')`) and label-print reads: unchanged (both were open-only).

## UI

- PDA picking list: status filter gains both new statuses (replacing
  `finished`); group order `picking → allocated → picking_finished →
  measuring_finished`; finished orders stay non-selectable.
- Admin status override modal + list filter: full 8-value set.
- i18n (`layers/i18n` en-US/zh-CN/zh-HK): `status.picking.picking_finished`
  ("Picking finished" / 揀貨完成 / 拣货完成) and `status.picking.measuring_finished`
  ("Measuring finished" / 複核完成 / 复核完成) replace `status.picking.finished`.
- PDA status badge maps both to the existing finished (grey) badge style.

## Out of scope

- No change to the outdated-scan-warning hold (stays on explicit Finish).
- No reversion of `measuring_finished` → `picking_finished` on box reopen
  (reopened boxes re-enter the measuring queue via the existing status rule).
- Shipping does not require `measuring_finished` (same as before — shipping a
  `picking_finished` order remains possible).
