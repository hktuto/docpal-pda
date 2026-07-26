# Navigation

## Home screen

The home screen (`pages/index.vue`) shows the main menu cards:

- Receiving
- Put-away
- Picking
- Measuring
- Goods Verify

Tap a card to enter that flow.

![Home screen](../user-menu/assets/home-page.png)

## App header

`components/AppHeader.vue` appears on most screens and provides:

- A back button to return to the previous screen.
- A reset-database button (demo only).
- A logout button.
- A language switcher (`layers/i18n/components/LanguageSwitcher.vue`).

## Detail pages

Most flows follow a list → detail pattern:

1. A list page shows open orders/tasks.
2. Tapping an item opens a detail page.
3. The detail page shows header information and action rows.
4. A floating action button (`ScanFab`) often opens a scan or action modal.

![Example detail page](../flows/receiving/assets/receiving-detail.png)

## Common UI patterns

- **DetailHeader** — order/task title, status badge, and summary.
- **DetailRow** — a labeled value row used throughout detail pages.
- **EmptyState** — shown when a list has no items.
- **ScanFab** — circular floating button that triggers a scan or action.
