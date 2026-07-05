# Composables

Composables live in `composables/` and contain reusable Vue logic.

## Quick reference

| Composable | Purpose |
|------------|---------|
| `useAuth.ts` | Login/logout/restore. |
| `useDb.ts` | Drizzle client from the provided PGlite instance. |
| `useLabelScan.ts` | Parse and manage scanned label input. |
| `useScanMatchers.ts` | Match parsed label data to receiving/picking records. |
| `useMockOcr.ts` | Simulate OCR normalization and errors. |
| `useRectangleDetection.ts` | Android native rectangle detection wrapper. |
| `useStatusBadge.ts` | Status badge styling/state helper. |
| `useStatusLabel.ts` | Status label helper. |
| `useVisibleReload.ts` | Reload data on mount and visibility/focus events for Capacitor. |
| `useLabelScanReview.ts` | Review-modal state for label scans. |

## Agent note

When a new cross-cutting concern appears, prefer adding a focused composable over duplicating logic in pages or components.
