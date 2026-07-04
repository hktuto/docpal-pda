# Shared Components

These components are reused across multiple flows.

![Shared components in context](../flows/receiving/assets/receiving-detail.png)

## AppHeader

`components/AppHeader.vue`

Top header with back button, reset DB, logout, and language switcher.

## DetailHeader

`components/DetailHeader.vue`

Page header for detail pages: title, status badge, and summary row.

## DetailRow

`components/DetailRow.vue`

Simple labeled-value row used throughout detail pages.

## StatusBadge

`components/StatusBadge.vue`

Colored badge showing an entity status. Driven by `composables/useStatusBadge.ts`.

## EmptyState

`components/EmptyState.vue`

Placeholder shown when a list has no items.

## ScanFab

`components/ScanFab.vue`

Circular floating action button that triggers a scan or primary action.

## LanguageSwitcher

`components/LanguageSwitcher.vue`

Inline buttons to switch the app language.

## Modals

- `components/LabelScanReviewModal.vue` — review and submit scanned label data.
- `components/BoxMeasurementsModal.vue` — enter shipping box dimensions.
- `components/ReportIssueModal.vue` — generic issue reporting.
- `components/PickingIssueReportModal.vue` — picking-specific issue reporting.
- `components/SelectShelfDialog.vue` — choose a destination shelf.
