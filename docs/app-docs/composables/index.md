# Composables

Composables live in `composables/` and contain reusable Vue logic.

## Quick reference

| Composable | Purpose |
|------------|---------|
| `useAuth.ts` | Login/logout/restore. |
| `useLabelScan.ts` | Parse and manage scanned label input. |
| `useReceivingScan.ts` | Receiving scan submission: server-side match, 409 → candidate review flow. |
| `useScanMatchers.ts` | Client-side label validation for picking/put-away/measuring scans. |
| `useRectangleDetection.ts` | Android native rectangle detection wrapper. |
| `useStatusBadge.ts` | Status badge styling/state helper. |
| `useStatusLabel.ts` | Status label helper. |
| `useVisibleReload.ts` | Reload data on mount and visibility/focus events for Capacitor. |
| `useLabelScanReview.ts` | Review-modal state for label scans. |
| `useHardwareScanner.ts` | Hardware scan input: fast intent-broadcast path (via `useScannerBroadcast`) plus keyboard-wedge fallback; broadcast scans replace the value of a focused `data-scan-fill` input instead of running the match pipeline; used by receiving/picking detail pages. |
| `useScannerBroadcast.ts` | Capacitor wrapper for the native `ScannerBroadcast` plugin (no-op in browser); on Honeywell devices the native side feeds it from the DCS claim path instead of the manifest receiver. |
| `useScannerConfig.ts` | Scanner symbology whitelist (`useSupplierSymbologyScope` / `useBrandSymbologyScope`, auto-branches xcheng vs Honeywell natively) + `getScannerDeviceInfo()` platform detection. |
| `useWarehouse.ts` | Data access entry point — the one memoized `WarehouseService` (backend HTTP adapter) per API base URL. |
| `useWarehouseEvents.ts` | Server-sent events bus: EventSource singleton; list pages subscribe via `useVisibleReload` topics. |
| `useFlowSteps.ts` | Resolves the backend flow-step config (`loadFlowSteps` is wired from the default layout); gates home tiles and the flow chain, carries the CN-receiving flag. |
| `useViewConfig.ts` | Shared ref of the resolved `pdaViewConfig` from `GET /config` — per-list titles/meta/chips display config (supersedes list templates). |
| `useListTemplates.ts` | Legacy per-list row display templates from `GET /config`; mapped into `useViewConfig` on newer backends. |
| `useServerHealth.ts` | Backend reachability watchdog — polls `GET /health`; `serverDown` drives `ServerDownOverlay`. |
| `usePageHeader.ts` | Detail pages register their title, status badge, info rows and actions into the AppHeader (replaces the retired `DetailHeader`). |
| `useAssignedToMe.ts` | "Assigned to me" badge text for task list rows naming the current user (`assignee` scoping, spec 2026-11-01). |
| `useToast.ts` | App-wide toast queue, rendered by the global `ToastHost`. |
| `errorMessage.ts` | `useErrorMessage()` — turns a caught error into display text (`I18nError` codes map to `errors.*` i18n messages). |
| `useOrderScanNav.ts` | Global order-link QR navigation (mounted in `app.vue`) — ships/picking-list order codes open the right page from any screen. |
| `usePickingScanQueue.ts` | Scan queue state for the picking scan screen: accepted/rejected scan rows with i18n rejection messages. |
| `usePickingScanSession.ts` | Applies a picking scan against the order detail (part/date-code matching, shelf-stock check, re-scan credit). |
| `usePickingWorkLock.ts` | Page-driven picking work lock — holds the server-side lock on the order while the page is mounted (3-min refresh, expires 10 min after `working_at`) so recompute leaves its allocations untouched. |
| `useLabelingOrders.ts` | Labeling queue list state (shared with the labeling detail flow). |
| `useLabelPrintingOrders.ts` | Label-printing queue list state (shared with the label-printing detail flow). |
| `useOutdatedWarning.ts` | Global queue of supplier outdated date-code scan warnings; `OutdatedWarningDialog` shows them one at a time. |
| `useFontSize.ts` | Global UI text-size setting (px on `<html>`, rem-based CSS), persisted per device like the locale. |
| `useCountryList.ts` | Shared cached `country_list` rows for the COO/COW dropdowns (`CountrySelect`). |

## Agent note

When a new cross-cutting concern appears, prefer adding a focused composable over duplicating logic in pages or components.
