# Android PDA Scanner Setup

How to set up the hardware barcode scanner on the Android PDA for the
warehouse app (`com.docpal.warehousedemo`, the Capacitor app).

The PDA's built-in scan engine can deliver barcodes two ways:

- **Keyboard wedge** ("Output to keyboard") — types the code character by
  character into the app. Works everywhere but is **slow** (each character
  travels through the Android input pipeline).
- **Broadcast** ("Output to broadcast") — sends the whole barcode in one
  Android intent. This is the fast path the app is built to receive.

## 1. Install the app

The scanner broadcast support must be in the installed APK (added
2026-07-13). To build and install from the dev machine:

```bash
# repo root, web dev server stopped
export NUXT_PUBLIC_API_BASE_URL=http://<dev-machine-LAN-IP>:3001
pnpm --filter @warehouse/web generate
pnpm --filter @warehouse/web cap:sync
cd apps/web/android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:installDebug
```

The app talks to the API over the network, so `NUXT_PUBLIC_API_BASE_URL`
must be baked in at generate time and the API
(`pnpm --filter @warehouse/api dev`) must stay running and reachable. If
the dev machine's LAN IP changes, regenerate and reinstall.

## 2. Configure the scanner (one-time per device)

Open the scanner's settings app → **Function settings**:

| Setting | Value |
|---------|-------|
| Barcode data output mode | **Output to broadcast** |
| PackageName (directional output) | `com.docpal.warehousedemo` |
| ClassName (directional output) | `com.docpal.warehousedemo.ScannerBroadcastReceiver` |
| Enable Intent | ON |
| Scan Result Action | `com.wclsolution.docpal.action.BARCODE_SCANNED` |
| Scan Result Data Key | `barcode` |

Notes:

- The firmware's default data key is misspelled **`bacode`** — the app
  accepts both spellings, so either works.
- Do **not** use "Output to broadcast/keyboard" combined mode: scans would
  arrive twice. (The app suppresses the keyboard echo for 1.5 s after a
  broadcast as a safety net, but the pure broadcast mode is the correct
  configuration.)
- Scanning only does something on pages that listen for hardware scans
  (receiving order detail, picking order detail). On other pages a scan is
  ignored, same as before.

## 3. Verify

With the device connected to the dev machine:

```bash
'/d/android/platform-tools/adb.exe' logcat -s ScannerBroadcast
```

Each trigger pull should print one line within a fraction of a second:

```
I ScannerBroadcast: scan broadcast received: <barcode text>
```

Also confirm the app UI reacts (e.g. on a receiving order detail, the
scanned item's received quantity increases and a success toast appears).

> This device's ROM suppresses DEBUG-level logcat lines, so the app logs
> scan events at INFO level — use the command above, not a `*:D` filter.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| No log line at all when scanning | Output mode still "Output to keyboard", or wrong PackageName/ClassName | Re-check the table above; watch for characters being typed into the app (wedge mode) |
| `scan broadcast without barcode extra, extras: ...` | Scan Result Data Key mismatch | The log prints the actual key/value — set the data key to `barcode` (or rely on the `bacode` fallback) |
| `app not ready, scan dropped` | Scan arrived before the app finished starting | Scan again after the app is visible |
| UI does not change but log shows the scan | You are on a page without hardware-scan support, or a dialog is open | Use a receiving/picking detail page; close dialogs |
| Scan works but feels laggy | Wedge fallback active (output mode = keyboard) | Switch to "Output to broadcast" |

## Fallback behavior

If the scanner is left in keyboard mode, the app still works via the wedge
path (key events buffered until Enter, 300 ms idle gap) — just slower. In a
desktop browser only the wedge path exists.
