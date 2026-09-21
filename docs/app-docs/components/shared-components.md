# Shared Components

These components are reused across multiple flows.

![Shared components in context](../flows/receiving/assets/receiving-detail.png)

## AppHeader

`components/AppHeader.vue`

Top header with back button, reset DB, logout, and language switcher. On detail
pages it also renders the page's dynamic title and status badge in the title
bar, plus a dedicated page-action dropdown (horizontal-dots icon left of the
⋯ kebab) holding the page's info rows and action buttons/links.

## usePageHeader

`composables/usePageHeader.ts`

Composable (not a component) detail pages call in setup to register their
title, status badge, info rows and actions into the AppHeader. Every field
accepts a getter so the header stays live; the registration is keyed to the
registering route and ignored after navigation. Replaces the retired
`DetailHeader` card.

## DetailRow

`components/DetailRow.vue`

Simple labeled-value row used throughout detail pages.

## EmptyState

`components/EmptyState.vue`

Placeholder shown when a list has no items.

## List rows

CSS primitives in `assets/css/main.scss` (no Vue component).

The shared work-queue list pattern: a `.list-panel` container holds dense
`.list-row` items separated by hairline dividers (~60 px each) instead of
spaced cards. Rows are two lines — title + status badges, then a muted meta
line — with a `.list-row__aside` on the right for counts/dates and a chevron.
Variants: `.list-row--disabled`, `.list-row--done` / `.list-row--danger`
(left accent), `.list-row--expandable` (the main area is a `.list-row__toggle`
button that opens a full-width `.list-row__detail` block; chevron rotates via
`.list-row__chevron--open`), and `.list-group-header` subheaders inside the
panel (used for carton groups on the receiving detail). `.list-toolbar` keeps
filters/search sticky under the app header. Used by every flow list page and
the receiving/picking detail item sections.

## ScanFab

`components/ScanFab.vue`

Circular floating action button that triggers a scan or primary action.

## LanguageSwitcher

`layers/i18n/components/LanguageSwitcher.vue` (shared Nuxt layer, also used by the admin app)

Inline buttons to switch the app language.

## Modals

- `components/LabelScanReviewModal.vue` — review and submit scanned label data.
- `components/BoxMeasurementsModal.vue` — enter shipping box dimensions.
- `components/ReportIssueModal.vue` — generic issue reporting.
- `components/PickingIssueReportModal.vue` — picking-specific issue reporting.
- `components/SelectShelfDialog.vue` — choose a destination shelf.
