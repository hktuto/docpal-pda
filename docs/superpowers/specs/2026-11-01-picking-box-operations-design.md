# Picking box operations redesign — design spec

Date: 2026-11-01
Status: implemented

## Context

The PDA picking scan page (`apps/pda/pages/picking/unified/[id].vue`) manages shipping
boxes through `PickingBoxesSection`. Three operational gaps:

1. Operators who scan items one-by-one end up with many scanned-but-unboxed
   `picking_packages` (`shipping_box_id IS NULL`) and must box each one manually
   (per-package box select + add, or add-all into one box).
2. The "Scan box" button (scan a pre-printed box label to adopt its id, old page
   `apps/pda/pages/picking/[id].vue` `scanBoxId` / `createBoxWithId`) is dead weight:
   users never print box labels. The button is already unwired on the unified page.
3. There is no way to pick into a box created by another order from the dialog side
   (only the per-box "scan into box" arm on boxes the order already owns), and no way
   to close a box from the picking page — closing only happens at the measuring page
   (measuring step on) or at verify completion (measuring off, verify on).

## Goals

1. **One box per unboxed item**: a single action creates one new shipping box per
   scanned-but-unboxed package of the order and packs the package into it.
2. **Remove the scan-box-label flow** everywhere (button + scan-to-create fallback).
3. **Close box on the picking page** when the measuring step is disabled.
4. **Choose-box dialog**: pick any existing open box (including boxes created by other
   picking orders — cross-order packing already works server-side via
   `POST /shipping-boxes/:id/scan`) and scan items into it.

## Non-goals

- Changing the measuring-step flow (measuring on → boxes still close at the measuring
  page after the re-scan; the picking-page Close button is hidden).
- Changing the one-COO-per-box rules (`box_coo_mismatch` still enforced by
  `addPackageToBox` / scan-into-box; box-each-unboxed creates one box per package so
  no mixing occurs).
- Box label printing.

## Backend changes (`apps/backend`)

### `POST /picking-orders/:id/box-each-unboxed` → `boxEachUnboxedPackage`

`src/db/picking.ts`, one transaction, mirrors `addAllUnboxedToShippingBox`:

- `loadOrderForWrite` + `assertOrderWritable` + `assertActor`.
- Load the order's unboxed packages (oldest first).
- For each package: mint a box id via `nextBoxId(tx, "S")`, insert the open
  `shipping_boxes` row + `shipping_box` open transition log (same as
  `createShippingBox`), `assignPackageToBoxTx`, `prefillShippingBoxFromSources`, and
  the per-item `scanned → boxed` transition log.
- Returns `{ created: number, boxIds: string[] }` (201). `created: 0` when nothing is
  unboxed (the PDA disables the button in that state anyway).

### `GET /shipping-boxes` → `listOpenShippingBoxes`

All `status = 'open'` boxes, oldest first, each with:

```json
{ "id", "orderId", "orderNo", "packageCount", "boxSize", "netWeight",
  "grossWeight", "destinationCountry", "createdDate" }
```

`orderId`/`orderNo` come from the creator order (`picking_order_id`, informational
only — a box may hold packages from any open picking order). Returned as
`{ boxes: [...] }`. Registered on `pickingRoute`; no extra scoping, matching the
cross-order scan-into-box semantics.

### `closeShippingBox` guard relaxation (measuring step off)

Today close requires `rescanned_qty >= qty` (the measuring re-scan), a box size, and
positive weights. When the measuring step is disabled there is no measuring re-scan
and the measuring-off verify completion already closes boxes without size/weights
(`src/db/verify.ts` completeVerifyTask). So when `isStepEnabled("measuring")` is
false, `closeShippingBox` skips both the `all_packages_must_be_verified` guard and
the box-size/weights guards. The destination fallback and the verify-task spawn
(+ rescanned credit reset) are unchanged.

## PDA changes (`apps/pda`)

### Service layer

- `services/types.ts`: `OpenShippingBox` DTO (fields above).
- `services/warehouse.ts` + `services/adapters/backendWarehouse.ts`:
  - `listOpenShippingBoxes(): Promise<OpenShippingBox[]>` → `GET /shipping-boxes`
  - `createBoxPerUnboxedPackage(pickingOrderId): Promise<{ created: number; boxIds: string[] }>`
    → `POST /picking-orders/:id/box-each-unboxed`

### `components/picking/PickingBoxesSection.vue`

- Remove the "Scan box" button, the `scan-box` emit and the `scanningBox` prop.
- Header gains (shown when `actionable`):
  - **Choose box** (`choose-box` emit) — opens the choose-box dialog.
  - **Box each unboxed** (`box-each-unboxed` emit) — disabled when
    `unboxedCount === 0` or busy.
- Each open, non-empty box card gains a **Close** button (`close-box` emit), shown
  only when the new `closable` prop is true (the page passes
  `!flowSteps.measuring`).

### New `components/picking/ChooseBoxDialog.vue`

Modal listing open boxes (box id, creator order no, package count, destination,
box size). Props: `open`, `boxes: OpenShippingBox[] | null` (null = loading), and the
current order id to tag own-order boxes. Emits `select(boxId)` and `close`.

### `pages/picking/unified/[id].vue`

- Drop `:scanning-box="false"`; wire `choose-box`, `box-each-unboxed`, `close-box`.
- `boxEachUnboxed()`: confirm → service call → toast with created count → reload.
- `closeBox(boxId)`: confirm → `closeShippingBox` → toast → reload (409s surface as
  toasts).
- `chooseBox()`: fetch open boxes, open the dialog; on select, arm
  `scanIntoBoxId = boxId`, expand the boxes section, toast.
- An armed-box banner appears whenever `scanIntoBoxId` is set (box id + Stop) so a
  cross-order armed box (no card on this order) is visible and can be disarmed.
- `load()` disarm logic: only disarm when the armed box is among the order's own
  boxes and no longer open; a cross-order armed box stays armed (a stale box fails
  loudly on the next scan with `shipping_box_not_open`).

### `pages/picking/[id].vue` (old detail page)

- Remove `scanBoxId`, `createBoxWithId`, `scanningBox` and the hardware-scanner
  scan-to-create-box fallback (a non-armed scan now just shows the
  use-scan-mode toast).
- Wire `close-box` / `box-each-unboxed` / `choose-box` like the unified page (it
  already has `scanIntoBoxId` + `scanIntoBox`).

### i18n (`layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`)

Add `picking.boxesSection.{chooseBox, closeBox, boxEachUnboxed, boxEachConfirm,
boxEachDone, closedBox, armedBanner}` and `picking.chooseBoxDialog.{title, empty,
order, packages, select}`; remove the now-unused `picking.boxesSection.scanBox`.

## Tests

`apps/backend/src/db/picking.test.ts`:

- `boxEachUnboxedPackage`: one box per unboxed package, correct membership, `created`
  count, `{created: 0}` when nothing unboxed.
- `listOpenShippingBoxes`: open boxes only, package counts + creator order no.
- `closeShippingBox` with `_setFlowStepsDisabledForTests(["measuring"])`: closes an
  unverified, unmeasured box; with measuring on the existing guard tests stand.

## Verification

- `pnpm --filter @warehouse/backend build` + `test` (Postgres via docker compose).
- `pnpm --filter @warehouse/pda test` + `nuxt prepare`.
