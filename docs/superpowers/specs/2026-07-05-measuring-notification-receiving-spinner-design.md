# Measuring Task Notification & Receiving Confirmation Spinner

## Goal

1. Notify the operator when a new measuring task is created.
2. Improve the perceived performance of confirming a receiving order (pending → in_hand) by showing a loading spinner.

## Context

- Measuring tasks are created in `db/picking.ts` (`finishPickingOrder` and `maybeAutoFinishPickingOrder`) when a picking order reaches `finished`.
- Receiving confirmation is handled in `pages/receiving/[id].vue` by `confirmReceivingOrderArrived` in `db/receiving.ts`.
- After the status update, `confirmReceivingOrderArrived` calls `allocatePendingPickingOrders(db)` from `db/allocate.ts`, which can take a noticeable amount of time.
- There is currently no global toast/snackbar system.

## Design

### 1. Toast notification for new measuring tasks

#### Components

- `composables/useToast.ts` — a lightweight global toast store using a reactive singleton. Exposes `toasts`, `showToast(message, options?)`, and `dismissToast(id)`.
- `components/ToastHost.vue` — renders the active toasts and mounts in `layouts/default.vue`.
- Update `pages/picking/[id].vue` to show the toast after `finishPickingOrder` succeeds and the order detail reloads.

#### Behavior

- The toast appears at the bottom-center of the viewport.
- It auto-dismisses after 3 seconds.
- It supports a primary action (e.g., a link to the newly created measuring task).
- For the explicit **Finish** action on the picking detail page, after `finishPickingOrder` succeeds and the order reloads, show:
  - EN: *"Measuring task created"*
  - ZH-HK: *"測量任務已建立"*
  - ZH-CN: *"测量任务已创建"*
- The auto-finish path (`maybeAutoFinishPickingOrder`) is intentionally left without a toast to avoid noise during rapid scan/box operations.

### 2. Receiving confirmation loading spinner

#### Components

- `components/LoadingOverlay.vue` — a centered full-viewport overlay with a spinner and label.
- Update `pages/receiving/[id].vue` to render the overlay while `confirming.value === true`.

#### Behavior

- When the operator taps **Confirm arrived**, `confirming` becomes `true` and the overlay appears.
- The overlay prevents additional taps and shows:
  - EN: *"Confirming arrival..."*
  - ZH-HK: *"確認收貨中..."*
  - ZH-CN: *"确认收货中..."*
- It disappears when `confirmArrival` finishes (success or error).

## Files to change

- `composables/useToast.ts` (new)
- `components/ToastHost.vue` (new)
- `layouts/default.vue`
- `pages/picking/[id].vue`
- `components/LoadingOverlay.vue` (new)
- `pages/receiving/[id].vue`
- `i18n/locales/en-US.ts`
- `i18n/locales/zh-HK.ts`
- `i18n/locales/zh-CN.ts`

## Out of scope

- Optimizing the `allocatePendingPickingOrders` call.
- Push notifications or background sync.
- Real-time badges on the home/menu screen.
- Changing the picking auto-finish behavior.

## Testing

1. Finish a picking order and verify the toast appears.
2. Confirm a receiving order and verify the spinner overlay appears and disappears.
3. Run `pnpm nuxt prepare` and the existing test suite.
