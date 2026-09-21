# Detail-page titles/actions in the app header — design (2026-09-21)

Workers should see only task content on detail pages. Today every detail page opens with a
`DetailHeader` card (title + status badge + action buttons + expandable "more info"). This spec
moves all of that into the sticky `AppHeader` and deletes the card:

1. The dynamic page title (e.g. receiving order `displayName`, picking `orderNo`) and the status
   badge render **in the app header's title bar**.
2. Page actions (Confirm arrived, Put away remaining, Scan, Finish picking, …) and the former
   expanded info rows move into a **dedicated page-action dropdown** on the header's right side —
   a separate horizontal-dots icon immediately left of the existing ⋯ kebab (NOT merged with
   settings/logout), shown only when the page registered info or actions.
3. The in-page `DetailHeader` card is removed entirely, freeing vertical room.

## `usePageHeader` contract

New composable `apps/web/composables/usePageHeader.ts` — Nuxt `useState`-backed shared state so
the persistent `AppHeader` (layout) reacts to whatever the mounted detail page registers:

```ts
interface PageHeaderInfoRow { label: string; value: string }
interface PageHeaderAction {
  key: string; label: string;
  to?: string;                          // renders NuxtLink, closes the menu
  onClick?: () => void | Promise<void>; // renders button — awaited, then closes the menu
  danger?: boolean; disabled?: boolean;
}
interface PageHeaderConfig {
  title?: MaybeRefOrGetter<string | undefined>;
  badgeText?: MaybeRefOrGetter<string | undefined>;
  badgeClass?: MaybeRefOrGetter<string | undefined>;
  info?: MaybeRefOrGetter<PageHeaderInfoRow[]>;
  actions?: MaybeRefOrGetter<PageHeaderAction[]>;
}
```

Pages call `usePageHeader(config)` in setup; every field accepts a plain value or a getter so the
header updates live (status changes, remaining-items count, locale switch). Registration stores
`{ path: route.fullPath, config }`; consumers (AppHeader) apply the state only while
`state.path === route.fullPath`, so a stale registration from an unmounted page is ignored
automatically — race-free clearing on navigation, and list pages simply never register (they keep
the static `route.meta.title`).

`AppHeader.vue` resolves the config: title falls back to the existing meta-title logic when the
getter yields nothing (loading/error states); the badge renders next to the title with ellipsis
truncation (`flex-shrink: 0` on the badge). The page-action dropdown reuses the kebab's
outside-click pattern (opening one menu closes the other); the dropdown body lists info rows
(`label: value`, muted small text), a divider, then action rows (`.app-header__menu-row`,
`--danger` variant). New i18n key `appHeader.pageMenu` for the toggle's aria-label.

## Per-page mapping

| File | title | badge | actions | info rows |
|---|---|---|---|---|
| `pages/receiving/[id].vue` | `order.displayName \|\| order.batchNo` | raw `order.status`, `badgeClass(status)` | Confirm arrived (disabled while busy), Put away remaining → `/put-away/:id` (same visibility rules) | supplier, date code, delivery date, remaining items (conditional as before) |
| `pages/put-away/[id].vue` | `order.batchNo` | `useStatusLabel().receiving(status)` | — | supplier, delivery date |
| `pages/picking/[id].vue` | `order.orderNo` | `statusLabel.picking(status)` | Scan → `/picking/scan/:id`, Finish picking (same visibility/disabled rules) | customer, delivery date, PO no, ship-to, org, sub-inventory, locked-by |
| `pages/goods-verify/[id].vue` | `wclItemNo ?? partNo` | `statusLabel.goodsVerify(status)` | — | task date, shelf, box, expected qty, verified at/by |
| `components/MeasureBox.vue` (shared by `pages/verify/[boxId].vue` + `pages/measuring/[boxId].vue`) | `measuring.measureBox.boxTitle` | `statusLabel.box(status)` | View picking order, Enter measurements (same rules) | picking order numbers |

Visibility/disabled logic is preserved exactly — only the rendering location moves. Each page
loses its `headerExpanded` ref and its `props: { noPadding: true }` page meta (that flag existed
to pull the flush-top card under the header; the container padding returns to normal).
`pages/verify/[boxId].vue`'s Reopen/Complete buttons already live outside the card — untouched.

## Out of scope

- `pages/picking/scan/[id].vue` and `pages/stock-search/index.vue` keep their `noPadding` meta
  (their own flush-top layouts, unrelated to `DetailHeader`).
- No backend changes; no changes to list pages.
