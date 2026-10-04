# PDA app rewrite (`apps/pda`) + admin view layout config — design

Date: 2026-10-04

## Problem

`apps/web` was the first run of the PDA concept and has accumulated obsolete
logic and structural duplication:

- 4 orphaned label-printing pages (`box.vue`, `carton.vue`, `labels.vue`,
  `print-labels.vue`, ~1,200 lines, no inbound links, superseded by the
  backend `/print/*` proxy), plus a mock-OCR path (`useMockOcr.ts`) and
  `components/labels/ScanCode.vue`.
- No shared list-row component: all 7 list pages hand-write the same
  `.list-panel`/`.list-row` markup against global CSS classes, each with its
  own toolbar/filter/pagination copy.
- The list row is a left/right two-column layout (`__main` + `__aside` capped
  at 45% width). Titles have variable, often long lengths, so the aside
  squeezes them into ellipsis.
- The admin "custom view" (`pdaListTemplates`) is only `{title, meta}`
  template strings for the 6 list pages, edited as free-form text inputs in
  `apps/admin/pages/display-config.vue`. It cannot control layout, field
  selection beyond two lines, badges, or anything on detail pages (the
  list-row spec explicitly scoped detail pages out).
- Workers see more data than they need (org/sub-inventory codes, PO refs,
  allocation internals inline), with no way for an admin to trim it.

Requirement (`apps/pda/user-requirement.md`): rebuild the PDA client as a
clean `apps/pda` package; show workers only what they need; upgrade the
admin view setting from field-text templates to real layout customization.

## Decision

1. **New package `apps/pda`, same stack.** Nuxt 3 (`ssr: false`), Vue 3,
   plain CSS, `extends: ["../../layers/i18n"]`, Capacitor Android shell.
   Backend (`apps/backend`) is unchanged — this is a client-only project
   plus a new admin-editable view-config key. The value is deletion and
   structure, not a new framework; keeping the stack lets the Capacitor
   config, native plugins (`ScannerBroadcast`, `ScannerConfig`,
   `RectangleDetection`), Android manifest flags, and the `/server` picker
   carry over unchanged.

2. **Selective port, not blank-page rewrite.** `apps/web` carries
   battle-tested behavior that a rewrite would silently regress: receiving
   scan review / multi-item-box modals, aggregate verify matching, picking
   scan queue + cross-line split + sticky shelf-scan context, SSE-driven
   `useVisibleReload`, hardware-scanner symbology whitelists, server-down
   overlay, `127.0.0.1` device defaults. Each flow is ported page-by-page
   with its composables, and the audit table below is the checklist.

3. **View customization becomes a config schema, not richer template
   strings.** New top-level flow-config key `pdaViewConfig` (validated at
   boot like the other keys, edited via `GET/PUT /admin/flow-config`,
   `FLOW_CONFIG` env override wins, resolved onto `GET /config`). It
   subsumes `pdaListTemplates` (kept working; see Migration).

4. **Per-warehouse config only.** One `pdaViewConfig` per warehouse, same
   granularity as every other flow-config key. Per-role/per-user views are
   out of scope.

## Audit of `apps/web` (port / drop)

Pages (23):

| Page | Disposition |
| --- | --- |
| `index.vue` home tile grid | Port (tiles via `useFlowSteps`) |
| `login.vue`, `server.vue`, `settings.vue` | Port as-is |
| `receiving/index.vue` + `[id].vue` | Port; detail gains group-by (below) |
| `picking/index.vue` + `[id].vue` + `scan/[id].vue` | Port incl. scan queue, shelf-scan modes, brand symbology scope |
| `put-away/index.vue` + `[id].vue` | Port incl. shelf-scan, item-first scan |
| `goods-verify/index.vue` + `[id].vue` | Port |
| `verify/index.vue` + `[boxId].vue` | Port incl. aggregate matching |
| `measuring/index.vue` + `[boxId].vue` | Port incl. aggregate matching |
| `stock-search/index.vue` | Port |
| `box.vue`, `carton.vue`, `labels.vue`, `print-labels.vue` | **Drop** (orphaned, superseded by `/print/*`) |

Composables/utils: port `apiClient`, `useAuth`/`apiAuth`,
`backendWarehouse` adapter, `useWarehouseEvents` (SSE singleton),
`useVisibleReload`, `useFlowSteps`, `useListTemplates` (superseded by
view-config rendering), scan composables per flow (`useReceivingScan`,
`usePickingScanQueue`, `useScanMatchers`, `measuringAggregateMatch`),
`useScannerBroadcast`/`useHardwareScanner`/`useScannerConfig` +
`useSupplierSymbologyScope`/`useBrandSymbologyScope`,
`useServerHealth`/`ServerDownOverlay`, `usePageHeader`, `serverHost`.
Drop `useMockOcr`, `components/labels/ScanCode.vue`. Shared presentation
primitives (`DetailRow`, `ScanFab`, `EmptyState`, `useStatusBadge`,
`useLabelScanReview`) are ported but restyled onto the new shared
components.

## PDA UI design

### Shared list infrastructure (new)

One `components/AppListPage.vue` (toolbar: search input + filter chips;
pagination: 50 rows + load-more; `useVisibleReload` wiring) and one
`components/AppListRow.vue` used by every list page. This deletes the
per-page markup duplication.

### List row layout — single column

Replaces the left/right two-column row:

```
┌──────────────────────────────────────────┐
│ Title (wraps to 2 lines, no aside)  [chip]│
│ Meta line 1 (muted, ellipsis)            │
│ Meta line 2 (muted, ellipsis, optional)  │
└──────────────────────────────────────────┘
```

- Title full width, allowed to wrap to 2 lines instead of truncating.
- Status is a single small colored chip inline at the end of the title
  line — no right-hand badge column (the old `__aside` max-width 45% is
  what fought long titles).
- Up to 2 meta lines, both full width.
- Row min-height 3.75rem touch target; chevron retained.
- Expandable variant (`--expandable` + `--done` left border) carried over
  for detail pages.

### Progressive disclosure (worker simplification)

Default rendering shows only what a worker acts on: name/title, qty
progress, status. Reference data (org id, sub-inventory code, PO/line
refs, allocation internals) moves into the expanded row or a "details"
section. Exactly which fields appear is driven by `pdaViewConfig` (below),
so the admin — not the code — decides the trim level per warehouse.

### Receiving order detail — item grouping

- A group-by chip row above the items: **Invoice / Carton / Part no**.
  Grouping is client-side re-bucketing of the already-loaded item array
  (today: invoice → carton is hardcoded in `ReceivingItemsTab.groupsFor`).
- Sticky group headers with progress (`INV-1234 — 8/12 received`),
  collapsible groups.
- Part-no grouping merges expected qty across lines/invoices and shows
  per-group scan progress; expanding a group shows the underlying PO/line
  breakdown.
- Default grouping comes from `pdaViewConfig.receivingDetail.defaultGrouping`;
  the worker's chip choice is session-local.

## View-config schema (`pdaViewConfig`)

Top-level flow-config key, shaped per page:

```jsonc
{
  "pdaViewConfig": {
    "lists": {
      "receiving": {
        "title": "[name]",                 // same template syntax as pdaListTemplates
        "meta": ["[supplier_name] · [delivery_date]", "[status]"],
        "chip": "status"                   // which field feeds the inline chip
      }
      // ... picking, put-away, goods-verify, verify, measuring, stock-search
    },
    "receivingDetail": {
      "defaultGrouping": "invoice" | "carton" | "part-no",
      "itemFields": ["wcl_item_no", "expected_qty", "po_no", "date_code", "lot_code", "coo"],
      "expandedFields": ["box_id", "po_line", "reserved_qty", "picked_qty", "put_away_qty", "cow"]
    },
    "pickingDetail":  { "itemFields": [...], "expandedFields": [...] },
    "putAwayDetail":  { "itemFields": [...], "expandedFields": [...] }
  }
}
```

Rules:

- List `title`/`meta` keep the existing `[token]` template syntax and
  fallback chain (all-empty title → default → primary id; all-empty meta →
  line hidden). `meta` becomes an array (1–2 lines) instead of one string.
- `itemFields` / `expandedFields` are ordered allow-lists from a per-page
  field catalog (defined alongside the existing `PDA_LIST_FIELDS`
  catalogs); unknown fields are rejected at config validation (400), so the
  admin UI and the PDA renderer share one source of truth.
- Any missing key/field keeps the built-in default, which reproduces
  today's rows — an untouched config renders exactly the current UI
  (minus the two-column aside).

### Migration from `pdaListTemplates`

On read, if `pdaViewConfig.lists.<key>` is absent but
`pdaListTemplates.<key>` exists, the list title/meta resolve from the old
key (old configs keep working). The admin editor writes only
`pdaViewConfig`; `pdaListTemplates` remains accepted by
`PUT /admin/flow-config` for backward compatibility but is deprecated.
`GET /config` gains `viewConfig` alongside the existing `listTemplates`.

## Admin editor (`apps/admin/pages/display-config.vue`)

Card 3 ("PDA list rows") is replaced by a per-page view editor:

- Page selector (6 lists + 3 detail pages).
- For lists: title/meta template inputs with placeholder chips (today's UX)
  plus a layout preview; meta becomes two lines.
- For detail pages: the field catalog as a checkbox list with drag
  ordering, split into "row fields" vs "expanded fields"; receiving detail
  also gets the default-grouping select.
- Live preview in a phone-width frame rendering sample rows with the
  current draft config (replaces today's static sample text).
- Saves merged over the `warehouse_config` row via
  `PUT /admin/flow-config`, storing only keys that differ from defaults
  (same convention as today).

## Implementation phases

1. **Scaffold `apps/pda`** — package, i18n layer, Capacitor shell, native
   plugins, home/login/server/settings, apiClient + backend adapter,
   server-down overlay.
2. **Shared list infrastructure** — `AppListPage`/`AppListRow`
   (single-column), filter/pagination/reload composables, template
   rendering.
3. **Flow pages** in order: receiving (list + detail with grouping) →
   picking (list, detail, scan) → put-away → goods-verify → verify →
   measuring → stock-search. Scan composables ported flow-by-flow with
   their modals and symbology scopes.
4. **View config** — backend `pdaViewConfig` validation + `GET /config` +
   migration fallback; PDA renders lists/details from it; admin editor v2.
5. **Cutover** — parity check against the audit table, device UAT
   (NLS-MT95), `build:apk` pointed at `apps/pda`, delete `apps/web` and
   update `AGENTS.md` / `docs/app-docs/`.

## Out of scope

- Backend API changes beyond the additive `viewConfig` config plumbing.
- Per-role/per-user view configs.
- Admin console table customization.
- Reordering/hiding flow lists themselves or home tiles (flow-step
  enablement already covers tiles).

## Open questions

- Whether stock-search joins `pdaViewConfig.lists` in phase 4 or keeps its
  own fixed layout (it is denser than the flow lists).
- Whether `verify`/`measuring` detail pages need field catalogs in v1 or
  stay fixed (their aggregate-matching UI is specialized).
