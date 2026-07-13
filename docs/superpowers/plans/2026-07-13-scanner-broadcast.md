# Scanner broadcast delivery — implementation plan

1. `apps/web/android/app/src/main/java/com/docpal/warehousedemo/ScannerBroadcastPlugin.java`
   — new `@CapacitorPlugin(name = "ScannerBroadcast")`; registers exported
   receiver for `com.wclsolution.docpal.action.BARCODE_SCANNED` in `load()`,
   unregisters in `handleOnDestroy()`, `Log.d(TAG, ...)` per scan for logcat
   verification.
2. `MainActivity.java` — `registerPlugin(ScannerBroadcastPlugin.class)`.
3. `apps/web/composables/useScannerBroadcast.ts` — typed `registerPlugin`
   wrapper with no-op web `addListener` stub.
4. `apps/web/composables/useHardwareScanner.ts` — subscribe on mount, remove
   on unmount; broadcast delivery shares `enabled()` guard + `onScan`; clear
   wedge buffer and consume wedge key echo for 1500 ms after a broadcast.
5. `apps/web/tests/useHardwareScanner.test.ts` — mock `useScannerBroadcast`;
   tests: broadcast triggers `onScan`, respects `enabled`, suppresses wedge
   echo, wedge path unchanged.
6. `AGENTS.md` — document the broadcast scan path + required device setting.
7. Verify: `pnpm --filter @warehouse/web test`,
   `pnpm --filter @warehouse/web nuxt prepare`, gradle compile of
   `apps/web/android`.
8. Device: switch scanner output mode to "Output to broadcast",
   `pnpm generate && npx cap sync android && ./gradlew :app:installDebug`,
   verify via `adb logcat -s ScannerBroadcast` and timed scans.
