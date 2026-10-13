# Picking unified detail page (scan + boxing in one list) — design

Date: 2026-10-12

Operator feedback: opening a picking order today needs an extra tap to reach the
scan page, and the worker's view of "what do I pick, from where, and what is
done" is split across `pages/picking/[id].vue` (boxing/items) and
`pages/picking/scan/[id].vue` (scan session). This spec builds one unified
detail page — a single per-part item list whose collapsed row shows the whole
story (progress + allocations) and whose expanded row shows the scanned detail
(pending scans, box assignment). Boxing (shipping boxes) keeps a section below
the list.

**Staging**: this is a **parallel build for evaluation**. Nothing in
`pages/picking/[id].vue` / `pages/picking/scan/[id].vue` changes now. The new
page is served from `/picking/unified/:id`; the picking list links there for
the trial. When the user is happy with the flow, a follow-up change replaces
the detail page file and re-points links (see §8).

## 1. Goals

- One page per picking order: scan, review, confirm, and box without losing
  place.
- Collapsed row = whole story: item name, scanned progress as inline text,
  required qty with per-allocation source chips (`3K(1K SZA01-2626-CN-CN,
  2K SZB02A-2631-CN)`).
- Expanded row = scanned detail: pending (unconfirmed) queue rows, confirmed
  packages with box assignment, multi-line breakdown, planned allocations.
- No backend scan/boxing API changes; the only backend change is the additive
  `collapsedStyle` view-config knob (§6).

## 2. Non-goals

- No changes to scan/verify/measuring/printing behavior or their specs.
- No migration, no schema change, no change to the picking list page beyond
  the evaluation link.
- The deprecated `pdaListTemplates` stays untouched.
- The old pages keep working during evaluation; the swap (§8) is a separate,
  user-approved change.

## 3. Route & staging

- New page: `apps/pda/pages/picking/unified/[id].vue`, route
  `/picking/unified/:id`.
- Evaluation link: `pages/picking/index.vue` row `:to` becomes
  `/picking/unified/${po.id}` (one line; original `/picking/${po.id}` restored
  at the swap — by then the detail route IS the unified page, so no edit is
  needed).
- `utils/orderScanRoute.ts`: picking branch returns `/picking/unified/${id}`
  (order-link QRs from the admin shipper/Excel open the unified page; the
  work lock acquires on mount as it does on the scan page today).
- `usePickingWorkLock`: the unmount keep-lock check gains
  `/picking/unified/${orderId}` alongside the two existing prefixes, so
  evaluation navigation between list → unified behaves like list → detail.

## 4. Page structure

Sections top → bottom (all overlays render at page level):

1. **App header** (`usePageHeader`) — unchanged from today's detail page:
   order no, status badge, outdated-warning chip, info rows (customer,
   delivery date, PO, ship-to, org, sub-inventory, lock holder), Finish action
   when every item is fully boxed.
2. **Banners**:
   - `PickingIssueBanner` when `status === 'issue'` (unchanged).
   - Work-lock banner when `heldByOther` (unchanged copy/styling).
   - Box-match banner (`suggestedBox` + claim) — unchanged behavior, moved
     from the detail page.
   - Shelf-scan banner — in `pickingShelfScan` require-* modes: shows the
     sticky shelf context (`pendingShelf.label`) with a clear button, or the
     amber "scan shelf first" state when no shelf is pending. Renders on this
     page exactly as on the scan page today; item-label scans and OCR capture
     are gated on it.
3. **Unified item list** — new component `components/picking/PickingUnifiedItems.vue`
   (§5).
4. **Boxes section** — existing `components/picking/PickingBoxesSection.vue`
   reused unchanged (New Box / claim suggestion lives in banner 2, cancel,
   add-all-unboxed, scan-into-box arm). Moved below the list: scan first, box
   after.
5. **Sticky footer** (actionable orders only):
   - Left: OCR capture button (spinner while capturing; disabled in require-*
     modes without a pending shelf).
   - Right: **Confirm (N)** — disabled while applying, when the queue is
     empty, when held by another worker, or in require-* modes without a
     pending shelf. Mirrors the scan page's footer.
   - Hidden entirely for finished/issue/held orders (`actionable` false).

## 5. Unified item list (`PickingUnifiedItems.vue`)

Props: order items, pending queue rows, actionable flag, open boxes,
box-selections map, adding/removing maps, `viewConfig`. Emits: toggle, remove
queue row(s), add/remove package to box, update box selection. Grouping:
one row per part (`normalizePartNo`), merging the lines of the same part —
the scan page's `partGroups` grouping and the items section's merge toggle
(merged by default) are unified into this single merged view.

### Collapsed row

- **Line 1**: item name (`wclItemNo ?? partNo`), full width, wraps. No
  right-side elements — item names can be super long.
- **Line 2** (inline text only):
  `{scanned}/{required}` in compact KMB form, then — when the queue holds
  rows for this part — ` (+{queued} pending)`, then
  ` · {required}({chip}, {chip})` where each chip is
  `{qtyCompact} {batch}` and batch is:
  - lot allocation: `lotCode-dateCode-coocow` joined with `-`, empties skipped
    (`SZA01-2626-CN-CN`);
  - receiving-carton allocation (no lot, `allocation.boxId` set):
    `CTN {boxId}`;
  - receiving-area allocation (neither): the receiving-area label
    (`picking.itemsSection.receivingArea`).
  - allocations with `qty <= 0` are excluded; the allocation list renders
    only while the group is not fully scanned (`scanned < required`).
  - compact qty: `formatCompactQty` with uppercase suffixes (`3K`, `1.4M`,
    `2B`) — small variant exported from `utils/formatNumber.ts`.
- Done styling reuses `list-row--done` when `scanned >= required`.

Example collapsed row (part WCL-12345):

```
WCL-12345
2K/3K (+1K pending) · 3K(1K SZA01-2626-CN-CN, 2K SZB02A-2631-CN)
```

### Expanded row

- **Pending scans** — the part's queued/failed queue rows, aggregated per
  batch (part + lot/date/coo/cow + source), one line each:
  `qty · batch · QR|OCR`, red with the error text on failure, per-group
  Remove button (removes all keys of the aggregated group). Failed rows stay
  until removed (backend 409s and `allocation_changed` re-resolve behave as
  today).
- **Confirmed packages** — unboxed (box `<select>` + Add to box) and boxed
  (box chip + Remove, only from open boxes) — today's markup and behavior,
  including the `labelBarcode` display.
- **Line breakdown** — when a part spans several order lines: per-line
  `Line N (shipment S) · required x · scanned y` rows.
- **Planned allocations** — today's `<details>` allocation table (location
  with shelf warning, date/lot/COO/COW, source, allocated qty), gated by
  `pickingDetail.expandedFields` exactly as today.

### Config interaction (`pickingDetail.collapsedStyle`)

The collapsed row's second line has two modes:

- `"allocations"` (new default): the format above.
- `"fields"`: today's `itemFields`-driven meta line
  (`groupMeta` in `PickingItemsSection.vue`), for admins who prefer the
  old configurable fields. Used only when the order is actionable and not
  fully scanned; otherwise the plain `scanned/required` pair renders.

## 6. View-config knob (backend, additive)

`pdaViewConfig.pickingDetail` gains `collapsedStyle`:

- `apps/backend/src/config.ts`: `PdaDetailViewConfig` gains
  `collapsedStyle: "allocations" | "fields"`; default is `"allocations"`;
  the detail-section validation branch accepts the key (validated against the
  two literals; unknown key still throws).
- `apps/admin/utils/viewConfig.ts` mirror: interface + `defaultPdaViewConfig()`
  gain the same key/default.
- `apps/admin/pages/pda-view-config.vue`: the pickingDetail section gains a
  `collapsedStyle` select (two options, i18n labels).
- Absent key ⇒ default `"allocations"` (no DB migration; existing
  `warehouse_config` rows untouched).

## 7. Scan session mechanics (preserved, moved to the page)

Session state (queue, shelf context, pick-from-box dialog, OCR review)
lives in the page via a new composable `composables/usePickingScanSession.ts`
(same role as receiving's `useReceivingScan`); the modals
(`PickingScanReviewModal`, `ScanMultiItemModal`, `PickFromBoxDialog`) and
`PickingBoxesSection` are rendered by the page.

Scan routing — one page-level `useHardwareScanner`:

1. Armed scan-into-box takes every scan (cross-order packing; auto-disarms
   when the box leaves the open state on reload) — unchanged.
2. Supplier-label match → queue (`addScan`), gated as today: require-*
   modes need a pending shelf; `require-match` does the shelf-stock pre-check
   (`createShelfStockChecker` over `GET /picking-shelf-stock`); OCR capture
   needs the same shelf context.
3. Receiving-carton match → auto-queue everything the order still needs from
   the carton (`addCartonScan`).
4. Shelf/box barcode: require-* modes set/replace the sticky shelf context
   (`require-any` accepts an unmatched shelf); off mode opens the
   pick-from-box dialog (`no_match` toast when nothing matches).
5. **Removed**: the detail page's scan-to-create-box (an unmatched scan
   creating a shipping box from a pre-printed id) — unmatched scans now keep
   their scan-session meaning, and box creation is the New Box button only
   (generated id), which also removes the routing ambiguity.

Confirm (`applyAll`): each queued row POSTs `scanPickingItem` with its
allocation, scanned part keys, label barcode (QR rows), and the sticky
shelf/box context in require-* modes; after every applied scan the order
refetches and the queue re-resolves (`reresolveQueued` — the backend rebuilds
allocation ids); failed rows stay visible; partial-fail toast; the
`orderMatched` watch keeps its success beep + one-prompt-per-transition
auto-confirm.

Completion is **not** a separate card: rows turn done when their scanned
qty reaches the required qty, and the header Finish action (all items fully
boxed) completes the order. Leave warnings (route-leave + `beforeunload`)
fire when the queue is non-empty and not applying.

`useBrandSymbologyScope(orderBrands, { withShelfCodes: true })` applies at
page level (the boxing flow also scans shelf/box labels). `useVisibleReload`
refetches on mount/visibility/SSE topics as today.

## 8. Swap stage (after user sign-off — separate change)

1. `pages/picking/[id].vue` is replaced with the unified page (route stays
   `/picking/:id`; `definePageMeta` title `meta.pickingDetail`).
2. Delete `pages/picking/unified/[id].vue`.
3. `pages/picking/scan/[id].vue` becomes a redirect page:
   `navigateTo(`/picking/${id}`, { replace: true })` — old QRs/bookmarks keep
   working.
4. `utils/orderScanRoute.ts` picking branch → `/picking/${id}`;
   `usePickingWorkLock` keeps only the `/picking/${orderId}` prefix check.
5. `pages/picking/index.vue` needs no change (already `/picking/${po.id}`).
6. Update `docs/app-docs/flows/picking/{overview,steps,ai-scope}.md`,
   `docs/app-docs/ai/feature-registry.md`, `docs/app-docs/ai/code-map.md`.

## 9. Behavior regression checklist

All must keep working, verified in the evaluation build:

- Batch queue + Confirm with allocation re-resolve (spec
  2026-10-03-picking-scan-truth-and-aggregate-verify-design.md).
- Shelf-scan modes off / require-match / require-any: sticky banner,
  shelf-first gating of scans + OCR, scan-time stock pre-check, confirm-time
  `shelfCode`/`boxId` submission (spec
  2026-10-02-picking-shelf-scan-config-design.md).
- Pick-from-box dialog + carton auto-queue (off mode).
- Duplicate-raw guard, COO/COW batch checks, `allocation_changed` failure
  state, partial-fail toast.
- Scan-into-box armed state + auto-disarm on reload.
- Whole-box claim banner (`claimShelfBox`).
- Finish gated by `unresolved_outdated_warnings` (409 → toast + reload).
- Work lock: acquire/refresh/release; `heldByOther` read-only state.
- `orderMatched` beep + auto-confirm prompt (one per transition).
- Leave warnings with a non-empty queue.
- Brand symbology whitelist with shelf/box QR always decodable.
- View config: `collapsedStyle` both values, `expandedFields` gating.

## 10. Tests & docs

- Update: `tests/orderScanRoute.test.ts` (picking → `/picking/unified/{id}`),
  `tests/useOrderScanNav.test.ts`, `tests/usePickingWorkLock.test.ts`
  (unified prefix in the keep-lock check).
- New: unified page scan-routing matrix (label → queue, carton → queue,
  shelf/box → context or dialog, armed scan-into-box precedence, unmatched in
  off mode → `no_match`), collapsed-row rendering for both `collapsedStyle`
  values, pending-row aggregation/removal.
- Backend: `config.test.ts` covers `collapsedStyle` validation (both
  literals pass, unknown value throws, absent ⇒ default).
- i18n: new strings (pending segment, compact-qty context, admin
  `collapsedStyle` labels, any moved keys) in all three locales
  (`layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`).
- Update `docs/app-docs/flows/picking/` (overview/steps/ai-scope),
  `docs/app-docs/ai/feature-registry.md`, `docs/app-docs/ai/code-map.md`.

## 11. Files (evaluation stage)

**New**
- `apps/pda/pages/picking/unified/[id].vue` — unified page (header, banners,
  list, boxes, footer, modals, scanner routing).
- `apps/pda/components/picking/PickingUnifiedItems.vue` — unified list.
- `apps/pda/composables/usePickingScanSession.ts` — session state/ops
  (queue wiring, shelf context, box-pick, carton, OCR, confirm).

**Modified**
- `apps/pda/pages/picking/index.vue` — evaluation row link (one line).
- `apps/pda/utils/orderScanRoute.ts` — picking branch → unified route.
- `apps/pda/composables/usePickingWorkLock.ts` — unified prefix in keep-lock.
- `apps/pda/utils/formatNumber.ts` — uppercase compact variant.
- `apps/pda/utils/viewConfig.ts` — `collapsedStyle` type/default (mirrors
  backend).
- `apps/backend/src/config.ts` — `collapsedStyle` type/default/validation.
- `apps/admin/utils/viewConfig.ts` — mirror type/default.
- `apps/admin/pages/pda-view-config.vue` — `collapsedStyle` picker.
- Tests (PDA + backend) per §10.
