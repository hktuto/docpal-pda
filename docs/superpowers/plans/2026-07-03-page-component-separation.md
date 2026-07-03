# Page Component Separation Plan

## Status

**Draft / Blocked** — wait for the other in-flight feature branch to land before starting this refactor. This plan is ready to execute once that branch is merged.

## Problem

Several Nuxt pages have grown into large files that mix routing, data fetching, scan workflows, business actions, inline styles, and presentation markup:

| Page | Lines (current) | Concerns |
|---|---|---|
| `pages/receiving/[id].vue` | ~770 | Two tabs (receiving + picking), scan, box/package management, logs |
| `pages/picking/[id].vue` | ~508 | Header, boxes, items, allocations, packages, logs, mismatch reporting |
| `pages/put-away/[id].vue` | ~367 | Shelf boxes, available lots, scan |
| `pages/measuring/[taskId]/box/[boxId].vue` | ~281 | Packages, measurements, scan |
| `pages/goods-verify/box/[id].vue` | ~259 | Expected items, scan, verification |

This makes the pages hard to read, test, and maintain. Common patterns (loading/error states, detail rows, scan review, transition logs) are duplicated across files.

## Goal

Make pages thin controllers that delegate presentation to components and reusable logic to composables, without changing user-facing behavior or URLs.

## Guiding principle

- **Page**: parse route params, fetch top-level data, orchestrate actions, compose components.
- **Component**: own markup and local UI state.
- **Composable**: own reusable cross-page logic.

## Non-goals

- No new features.
- No backend/schema changes.
- No URL/route changes (the optional child-route idea for `/receiving/[id]/picking` is noted but out of scope unless explicitly requested later).

## Phase 1 — Shared composables

Extract duplicated controller logic first so later refactors can use it.

| Composable | Responsibility | Replaces code in |
|---|---|---|
| `composables/usePageReload.ts` | `onMounted(load)` + `visibilitychange`/`focus` reload listeners | `put-away/[id].vue`, `measuring/[id].vue`, `measuring/[taskId]/box/[boxId].vue`, `goods-verify/box/[id].vue` |
| `composables/useScanReview.ts` | `reviewOpen`, `review`, `onApplied`, `onRetake`, and `LabelScanReviewModal` wiring | `receiving/[id].vue`, `picking/[id].vue`, `put-away/[id].vue`, `measuring/[taskId]/box/[boxId].vue`, `goods-verify/box/[id].vue` |
| `composables/useTransitionLogs.ts` | Fetch logs and group by `entityId` | `receiving/[id].vue`, `picking/[id].vue` |
| `composables/useDetailState.ts` | `pending` / `error` / `data` refs with a safe `load()` wrapper | all detail pages |

## Phase 2 — Shared presentational components

Create small, reusable components for the most repeated UI blocks.

- `components/DetailRow.vue` — label/value row used in every detail header and card.
- `components/Badge.vue` — centralize `badgeClass()` helpers and inline badge classes.
- `components/EmptyState.vue` — unified loading / error / empty messages.
- `components/ScanButton.vue` — floating camera FAB used in 4+ pages.
- `components/TransitionLogList.vue` — transition log list from receiving/picking detail.
- `components/PackageList.vue` / `PackageCard.vue` — unboxed/boxed packages.
- `components/AllocationList.vue` / `AllocationCard.vue` — picking allocations.
- `components/ShippingBoxCard.vue` — shipping box summary in picking/measuring.
- `components/ShelfBoxCard.vue` — shelf box summary in put-away/goods-verify.

## Phase 3 — Consolidate duplicated CSS

Move the following repeated scoped styles to `assets/css/main.css` as global utilities, then remove them from individual pages:

- `.detail-row`
- `.detail-label`
- `.lot`
- `.card--done`
- `.badge--pending`, `.badge--in-hand`, `.badge--finished`

## Phase 4 — Split the largest pages

### `pages/receiving/[id].vue` (highest impact)

Extract:

- `components/receiving/ReceivingItemsTab.vue` — invoices/items + mismatch form.
- `components/receiving/ReceivingPickingTab.vue` — linked picking orders, allocations, packages, boxes.
- `components/receiving/ReceivingItemMismatchForm.vue` — per-item mismatch inputs.

Parent page keeps:

- route param and `load()` orchestration,
- tab state,
- scan entry point and modal wiring.

Target size: ~180 lines.

### `pages/picking/[id].vue`

Extract:

- `components/picking/PickingBoxesList.vue`
- `components/picking/PickingItemCard.vue` — item header + allocations + packages + logs + mismatch.
- `components/picking/PickingAllocations.vue`
- `components/picking/PickingPackages.vue`

Parent page keeps top-level load, `createBox`, `finish`, and scan entry point.

Target size: ~160 lines.

### `pages/put-away/[id].vue`

Extract:

- `components/put-away/ShelfBoxesPanel.vue`
- `components/put-away/PutAwayLotsPanel.vue`

Parent page keeps load and scan orchestration.

Target size: ~120 lines.

### `pages/measuring/[taskId]/box/[boxId].vue`

Extract:

- `components/measuring/BoxPackageList.vue`
- `components/measuring/BoxMeasurementsSummary.vue`

Target size: ~140 lines.

### `pages/goods-verify/box/[id].vue`

Extract:

- `components/goods-verify/ExpectedItemList.vue`

Target size: ~140 lines.

## Phase 5 — Verification

After each phase:

1. Run `pnpm nuxt prepare` to confirm types.
2. Run `pnpm generate` to confirm production build.
3. Manual Android check: log in, navigate receiving → picking → put-away → measuring → goods verify, and confirm:
   - loading/error/empty states still render,
   - label scan workflow still opens review modal and applies,
   - transition logs still expand/collapse,
   - box/package actions still work.

## Risks

- **Regression in scan workflows**: the scan-review wiring is the most duplicated and subtle logic. Extract it carefully and test on Android after each page.
- **Over-extraction**: components only used by one page should live next to that page (`components/<page>/...`) rather than in a shared folder.
- **Merge conflicts**: because another agent is editing code, do not start this refactor until that branch is merged and the repo is back to a clean state.

## Out of scope / future ideas

- Converting the receiving-detail picking tab into a child route `/receiving/[id]/picking`.
- Converting remaining inline styles to utility classes.
- Adding unit tests for the new composables.
