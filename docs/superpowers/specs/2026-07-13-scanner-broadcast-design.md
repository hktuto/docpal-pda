# Hardware scanner broadcast delivery — design

## Problem

On the Android PDA (Capacitor app, `com.docpal.warehousedemo`), hardware
barcode scans feel slow. The scanner service is configured with **Barcode data
output mode = "Output to keyboard"**, so it injects the decoded string into the
WebView one key event per character (keyboard wedge). Each key event travels
through the Android input pipeline and Chromium before the page's `keydown`
listener sees it, and `useHardwareScanner` then buffers until the Enter
terminator. A 20–30 character label takes roughly a second before the app can
even start matching.

## Evidence

- Scanner "Function settings" screen: output mode = keyboard; **Enable Intent**
  is already ON with Action Name `com.wclsolution.docpal.action.BARCODE_SCANNED`
  and Intent Parameters `barcode`.
- `apps/web/composables/useHardwareScanner.ts`: buffers printable keys, flushes
  on Enter; existing `[SCAN-TIME]` logs were added while profiling this.

## Design

Deliver scans as a single Android broadcast instead of per-character key
events:

1. **Native:** new local Capacitor plugin `ScannerBroadcastPlugin`
   (`apps/web/android/.../ScannerBroadcastPlugin.java`), registered in
   `MainActivity` next to `RectangleDetectionPlugin`. It receives the
   `com.wclsolution.docpal.action.BARCODE_SCANNED` broadcast two ways — a
   context-registered receiver (fully implicit broadcasts while running) and
   the manifest component `ScannerBroadcastReceiver` (explicit broadcasts
   targeted at PackageName + ClassName, which context receivers cannot
   catch) — and forwards the `barcode` extra to JS via
   `notifyListeners("scan", { value })`. Both paths share one dispatch that
   suppresses identical values within 400 ms (a package-targeted broadcast
   reaches both receivers). Receivers are exported because the sender is
   another app (the scanner service).
2. **Web wrapper:** `composables/useScannerBroadcast.ts` — `registerPlugin`
   with a no-op web stub, mirroring `useRectangleDetection.ts`.
3. **Composable:** `useHardwareScanner` additionally subscribes to the plugin's
   `scan` event. A broadcast scan goes through the same `enabled()` guard and
   `onScan` callback as a wedge flush, so `pages/receiving/[id].vue` and
   `pages/picking/[id].vue` need no changes. The keyboard-wedge path stays as
   the fallback (browser dev, devices without broadcast configured).
4. **Echo guard:** if the device is set to "Output to broadcast/keyboard",
   wedge key events still arrive after the broadcast. After a broadcast scan
   the composable clears the wedge buffer and consumes printable/Enter key
   events for 1500 ms (except those targeting input elements), preventing
   duplicate scans. Broadcasts themselves are never suppressed, so rapid
   consecutive scans still work.

## Device configuration (one-time, manual)

Scanner app → Function settings → Barcode data output mode → **"Output to
broadcast"**, with directional output set to:

- PackageName: `com.docpal.warehousedemo`
- ClassName: `com.docpal.warehousedemo.ScannerBroadcastReceiver`
- Scan Result Action: `com.wclsolution.docpal.action.BARCODE_SCANNED` (Enable Intent ON)
- Scan Result Data Key: `barcode`

Verify with `adb logcat -s ScannerBroadcast` — one line per scan (this ROM
suppresses DEBUG log lines, so the plugin logs at INFO level).

## Out of scope

- The native rewrite (`apps/android`) has its own wedge path; unchanged.
- Put-away / goods-verify web pages do not listen for hardware keys today; unchanged.
- Changing scanner settings programmatically (no documented config API).
