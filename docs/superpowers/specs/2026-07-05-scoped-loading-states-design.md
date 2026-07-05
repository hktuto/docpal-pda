# Scoped Loading States

## Goal

Improve perceived responsiveness by scoping loading indicators to the element that triggered the action, instead of blocking the entire page or showing a full-screen overlay.

## Context

- The receiving detail page currently shows a full-viewport `LoadingOverlay` while confirming arrival.
- Detail pages already use a full-page `EmptyState` for the initial data load (`pending`).
- Several actions already use per-element loading maps:
  - `pages/picking/[id].vue`: `adding`, `removing`, `creatingBox`, `cancellingBox`, `finishing`.
  - `pages/receiving/[id].vue`: `saving`, `creatingBox`, `addingPackage`, `removingPackage`, `confirming`.
- The pattern exists but is not applied consistently; some actions still block the whole UI.

## Design

### 1. Keep full-page loading only for initial page load

- List pages (`pages/*/index.vue`) keep their existing `loading` state and `EmptyState`.
- Detail pages keep the existing `pending` state and `EmptyState` for the initial fetch.
- After the first load, the page content must remain visible during all subsequent actions.

### 2. Button-level loading for primary actions

When a primary action is triggered, disable the button and replace its label with a spinner + loading text. The rest of the page stays interactive.

Actions:
- **Receiving detail → Confirm arrived** (`confirming` flag).
- **Picking detail → Finish picking** (`finishing` flag).
- **Picking detail → Create box** (`creatingBox` flag).

### 3. Row/item-level loading for per-item actions

Each row or item that triggers an async operation shows its own inline spinner. Use the existing keyed loading maps.

Actions:
- **Receiving detail → Receiving items tab** — Report issue / Save issue buttons (`saving[itemId]`).
- **Receiving detail → Picking tab** — Add to box / Remove from box buttons (`addingPackage[packageId]`, `removingPackage[packageId]`).
- **Picking detail → Items section** — Add to box / Remove from box buttons (`adding[packageId]`, `removing[packageId]`).
- **Label scan review modal** — Apply button (use a new `applying` flag or the existing saving/loading flag passed from the parent).

### 4. Remove full-page overlay from receiving confirmation

- Remove the `<LoadingOverlay v-if="confirming" ...>` render from `pages/receiving/[id].vue`.
- Keep the `components/LoadingOverlay.vue` component available for future use.

## Files to change

- `pages/receiving/[id].vue`
- `pages/picking/[id].vue`
- `components/receiving/ReceivingItemsTab.vue`
- `components/receiving/ReceivingPickingTab.vue`
- `components/picking/PickingItemsSection.vue`
- `components/picking/PickingBoxesSection.vue`
- `components/LabelScanReviewModal.vue`
- `i18n/locales/en-US.ts` (if new labels are needed)
- `i18n/locales/zh-HK.ts`
- `i18n/locales/zh-CN.ts`
- `docs/app-docs/ai/code-map.md` (if new shared primitives are added)

## Out of scope

- Changing data-fetch or mutation logic.
- Adding new shared components unless absolutely necessary.
- Optimizing the post-confirmation allocation step.

## Testing

1. Confirm a receiving order and verify only the Confirm button shows a spinner; the page content remains visible.
2. Finish a picking order and verify only the Finish button shows a spinner.
3. Create a box and verify only the Create box button shows a spinner.
4. Add/remove a package from a box in both picking and receiving flows and verify only the clicked item's button shows a spinner.
5. Apply a scan in the label review modal and verify the Apply button shows a spinner.
6. Run `pnpm nuxt prepare` and `pnpm test`.
