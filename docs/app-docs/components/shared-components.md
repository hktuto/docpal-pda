# Shared Components

These components are reused across multiple flows.

![Shared components in context](../flows/receiving/assets/receiving-detail.png)

## AppHeader

`components/AppHeader.vue`

Top header with a back button (everywhere except home), a report-a-bug
button (🐞, opens `BugReportModal.vue`), and on home a ⋯ kebab menu holding
the language switcher, Settings and Logout. On detail
pages it also renders the page's dynamic title and status badge in the title
bar, plus a dedicated page-action dropdown (horizontal-dots icon) holding the
page's info rows and action buttons/links.

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

## AppListPage / AppListRow

`components/AppListPage.vue` · `components/AppListRow.vue`

Shared work-queue list shell used by the ten flow queue list pages (receiving,
receiving-cn-scan, put-away, put-back, picking, labeling, label-printing,
measuring, verify, goods-verify). `AppListPage`
renders the sticky `.list-toolbar` (search input + filter chips) under the app
header, loading/error/empty states, a `shown/total` load-more footer, and the
`useVisibleReload` wiring (pass `reload` + SSE `topics`). `AppListRow` renders
one dense row — title plus inline chips, up to two muted meta lines, optional
`to` link or expandable toggle. Chips: status (`chipText`/`chipClass`), the
amber advisory (`warnText`), and the `.badge--assigned` "Assigned to me" badge
(`mineText`, from `useAssignedToMe.ts`).

## List row CSS

`assets/css/main.scss` also keeps the raw `.list-panel` / `.list-row`
primitives (`app-list-row` mirrors them) still used by detail-page item
sections, e.g. the picking items group. Rows are two lines — title + status
badges, then a muted meta line — with a `.list-row__aside` on the right for
counts/dates and a chevron.
Variants: `.list-row--disabled`, `.list-row--done` / `.list-row--danger`
(left accent), `.list-row--expandable` (the main area is a `.list-row__toggle`
button that opens a full-width `.list-row__detail` block; chevron rotates via
`.list-row__chevron--open`), and `.list-group-header` subheaders inside the
panel (used for carton groups on the receiving detail). `.list-toolbar` keeps
filters/search sticky under the app header. The raw primitives are used by the
receiving and picking detail item sections; the flow queue list pages get the
same look through `AppListPage`/`AppListRow`.

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
- `components/ScanMultiItemModal.vue` — split one scanned label's qty across multiple candidate line rows (put-away detail); rows locked by a previous apply run stay ok.
- `components/BugReportModal.vue` — in-app bug report (opened by the header 🐞): description + photo attachment, resized client-side before upload.

## Global overlays

Mounted once for the whole app, not by pages:

- `components/ServerDownOverlay.vue` (in `app.vue`) — full-screen "backend unreachable" screen driven by `useServerHealth`; manual retry plus a change-server escape to the `/server` picker.
- `components/ToastHost.vue` (in `layouts/default.vue`) — renders the `useToast` queue.
- `components/OutdatedWarningDialog.vue` (in `layouts/default.vue`) — one dismissible alert at a time from the `useOutdatedWarning` queue of supplier outdated date-code scan warnings.

## Form & filter controls

- `components/SearchableSelect.vue` — searchable dropdown for filters/forms; single-select by default (`v-model: string`, `""` = all), `multiple: true` switches to multi-select. The admin app has its own variant (`apps/admin/components/SearchableSelect.vue`) which defaults to multi-select.
- `components/FilterChipGroup.vue` — chip filter group (optionally grouped with headings); long lists get a built-in filter box so chips stay usable on a phone.
- `components/CountrySelect.vue` — COO/COW dropdown over the `country_list` master (`useCountryList`); keeps the current value and non-matching OCR candidates selectable.
- `components/InlineSpinner.vue` — small inline loading spinner for buttons and rows.

## MeasureBox

`components/MeasureBox.vue`

Shared closed-box re-measure body used by both the measuring and the verify
box pages: scans packages in (hardware scan aware) and shows dimensions /
weight; the pages differ only in which per-package flag (`verified` vs
`verifyVerified`) gates the scan.
