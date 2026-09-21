# Navigation

## Home screen

The home screen (`pages/index.vue`) shows the main menu cards:

- Receiving
- Picking
- Put-away
- Goods Verify
- Measuring
- Verify
- Stock Search

Tap a card to enter that flow. Steps disabled in the backend flow-step config do not show a card.

![Home screen](../user-menu/assets/home-page.png)

## App header

`components/AppHeader.vue` appears on most screens and provides:

- A back button to return to the previous screen.
- On detail pages: the order/task title and status badge in the title bar,
  and a page-action dropdown (horizontal-dots icon left of the ⋯ kebab) with
  the page's info rows and actions.
- A reset-database button (demo only).
- A logout button.
- A language switcher (`layers/i18n/components/LanguageSwitcher.vue`).

## Detail pages

Most flows follow a list → detail pattern:

1. A list page shows open orders/tasks.
2. Tapping an item opens a detail page.
3. The detail page's title, status, summary info and actions live in the app
   header (registered via `composables/usePageHeader.ts`); the page body shows
   only task content.
4. A floating action button (`ScanFab`) often opens a scan or action modal.

![Example detail page](../flows/receiving/assets/receiving-detail.png)

## Common UI patterns

- **usePageHeader** — detail pages register their title, status badge, info
  rows and actions into the app header.
- **DetailRow** — a labeled value row used throughout detail pages.
- **EmptyState** — shown when a list has no items.
- **ScanFab** — circular floating button that triggers a scan or action.
