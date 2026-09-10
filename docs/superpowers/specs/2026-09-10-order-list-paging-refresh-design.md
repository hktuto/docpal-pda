# Order List Paging + Refresh + Web GET Cache Removal — Design

Date: 2026-09-10
Status: implemented

## Problem

The receiving and picking order list pages fetch the **full** list
(`GET /receiving-orders`, `GET /picking-orders`) and filter/search client-side.
Lists grow unboundedly, and the 60 s client-side SWR cache
(`apps/web/services/apiCache.ts`) gave the user **no way to force a refresh**:
stale data persisted up to the TTL whenever SSE was disconnected or another
device changed data.

Measured reality: a full-list fetch costs ~30 ms, so caching buys almost
nothing while adding a whole invalidation layer (TTL, localStorage mirror,
SSE-driven prefix invalidation, `MUTATION_INVALIDATIONS` cross-prefix maps,
kill-switch plugin).

## Decisions

1. **Remove the web GET cache entirely.** Every `apiClient.get` is a plain
   fetch. Freshness now comes from the mechanisms that already exist:
   `useVisibleReload` (mount + visibility/focus + SSE topic subscriptions)
   reloads pages, and lists get an explicit refresh button.
2. **Server-side pagination** on the two list endpoints: `limit`/`offset`
   paging with `search` (and multi-value `status`/`allocation` for picking)
   pushed down to SQL. Search/filter correctness no longer depends on having
   every row client-side.
3. **Refresh button** on both list pages for an explicit, always-available
   reload.

## API changes

Both endpoints return a page envelope instead of a bare array:

```
GET /receiving-orders?status=&search=&limit=&offset=
  → { rows: ReceivingOrderListRow[], total: number }

GET /picking-orders?status=&allocation=&search=&limit=&offset=
  → { rows: PickingOrderListRow[], total: number }
```

- `status` (picking) and `allocation` accept comma-separated lists
  (`= ANY(...)`); a single value keeps old callers working
  (`?status=shipped`). Receiving `?status=` stays single-value.
- `search` is a case-insensitive substring match on the same fields the
  client used to filter: receiving → `batch_no`, supplier `name`;
  picking → `order_no`, `po_no`, `customer_code`.
- `total` comes from `COUNT(*) OVER ()` on the grouped query — one round
  trip, no separate count query. `limit`/`offset` are optional; omitting
  `limit` returns everything (still inside the envelope).
- Ordering unchanged (receiving `created_date DESC` + new `ro.id`
  tiebreaker for paging stability; picking `priority_seq, delivery_date,
  order_no`).

## Web changes

- `apiCache.ts`, `plugins/apiCache.ts`, the `apiCache` runtime-config key,
  cache read/write in `apiClient.get`, the `MUTATION_INVALIDATIONS`
  mutation-invalidation map, and every `clearApiCache()` call site
  (401 handler, login/logout, server switch) are deleted. The `wms-cache:`
  sweep in `utils/serverHost.ts` goes too. SSE (`useWarehouseEvents`) keeps
  only subscriber notification + toasts.
  - Kept: `getCachedSupplierQrTemplates` (`composables/useLabelScan.ts`) —
    an unrelated module-level memo of supplier QR templates.
- `WarehouseService.getReceivingOrders` / `getPickingOrders` return
  `ListPage<T> = { rows, total }` and accept query objects.
- Both list pages share one pattern:
  - PAGE_SIZE = 50; `hasMore = rows.length < total`.
  - Reset load (mount, filter change, search, refresh button): offset 0.
  - "Load more": offset = rows.length, append.
  - Visibility/SSE reload: one refetch with
    `limit = max(rows.length, PAGE_SIZE)`, offset 0 — the loaded window is
    refreshed in a single request.
  - Search input debounced ~300 ms, applied server-side; client-side
    computed filtering removed.
  - Refresh icon button in the toolbar (receiving: beside filter chips;
    picking: beside the filter button).
- New i18n keys `common.refresh`, `common.loadMore`, `common.showingOf`
  in all three locales.

## Consequences

- App restart no longer serves instant stale lists from localStorage; the
  first paint waits for a ~30 ms fetch. Accepted.
- Picking multi-status/allocation filters and both pages' search now work
  correctly beyond the loaded window (previously they only matched loaded
  rows once paging existed).
- Backend tests for `listPickingOrders` updated to the `{rows, total}`
  shape; web cache tests deleted.
