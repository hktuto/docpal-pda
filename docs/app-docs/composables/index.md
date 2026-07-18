# Composables

Composables live in `composables/` and contain reusable Vue logic.

## Quick reference

| Composable | Purpose |
|------------|---------|
| `useAuth.ts` | Login/logout/restore. |
| `useLabelScan.ts` | Parse and manage scanned label input. |
| `useReceivingScan.ts` | Receiving scan submission: server-side match, 409 → candidate review flow. |
| `useScanMatchers.ts` | Client-side label validation for picking/put-away/measuring scans. |
| `useMockOcr.ts` | Simulate OCR normalization and errors. |
| `useRectangleDetection.ts` | Android native rectangle detection wrapper. |
| `useStatusBadge.ts` | Status badge styling/state helper. |
| `useStatusLabel.ts` | Status label helper. |
| `useVisibleReload.ts` | Reload data on mount and visibility/focus events for Capacitor. |
| `useLabelScanReview.ts` | Review-modal state for label scans. |
| `useHardwareScanner.ts` | Hardware scan input: fast intent-broadcast path (via `useScannerBroadcast`) plus keyboard-wedge fallback; broadcast scans replace the value of a focused `data-scan-fill` input instead of running the match pipeline; used by receiving/picking detail pages. |
| `useScannerBroadcast.ts` | Capacitor wrapper for the native `ScannerBroadcast` plugin (no-op in browser). |

## Agent note

When a new cross-cutting concern appears, prefer adding a focused composable over duplicating logic in pages or components.
