# Supplier barcode-type whitelist → PDA scanner symbology control

Date: 2026-09-04
Status: implemented

## Problem

Supplier labels often carry several barcodes (different symbologies and formats). The PDA
hardware scanner decodes whatever is in front of it, so an operator aiming at the "good"
barcode can accidentally trigger a scan from a neighboring one. The app already validates
scans in software (supplier `qr_template` regex in `supplier_profiles`, plus the per-flow
matchers), but rejecting after the fact beeps/errors and slows the operator down.

## Device capability (verified on Movfast T23X, 2026-09-04)

The system scanner app `com.xcheng.scannere3` exposes an **exported** broadcast receiver
`com.xcheng.scannere3/.ScanTestReceiver` accepting:

- action `com.xcheng.scanner.action.ENABLE_SCANTYPE_BROADCAST`
- action `com.xcheng.scanner.action.DISABLE_SCANTYPE_BROADCAST`
- string extra `scantype` = the symbology's display name **as shown in the scanner settings
  app** (validated by `isValidType` against that app's localized string resources — exact
  match, e.g. `"QR CODE"` with a space, `"Code128"`, `"DATA MATRIX"`).

Each broadcast is equivalent to the enable/disable toggle in the settings app
(`E3Util.setCodeTypeOnOff` → native `configDecoderTag`). Verified live over adb: disabling
`Code128` made a Code128 scan produce no decode; re-enabling restored it.

Properties:

- **Runtime-only, device-global**: not written to the scanner app's SharedPreferences; a
  reboot (or the settings app) restores the saved configuration. Callers must re-apply on
  screen enter and restore on leave; the app also restores the full set at startup as crash
  recovery.
- The full supported symbology list (34 entries, display-name strings) is duplicated in
  `apps/web/android/.../ScannerConfigPlugin.java` (`ALL_SYMBOLOGIES`),
  `apps/web/composables/useScannerConfig.ts` (`SCANNER_SYMBOLOGIES`) and
  `apps/admin/utils/symbologies.ts` — keep the three in sync.
- On non-xcheng devices the explicit broadcasts have no receiver and are harmless no-ops.

## Design

- **Schema**: `supplier_profiles.barcode_types` (text array, nullable). NULL/empty = no
  restriction (device defaults). Non-empty = whitelist: only these symbologies decode.
- **Distribution**: the existing `GET /scan-templates` feed (already fetched+cached by every
  client for QR templates) carries `barcodeTypes` per supplier.
- **Admin**: the supplier-profile editor dialog gets a "Barcode types" checkbox grid;
  none checked = no restriction.
- **PDA apply points** (`useSupplierSymbologyScope(supplierCodeRef)` in
  `apps/web/composables/useScannerConfig.ts`): any scan screen that can resolve a supplier
  code applies the whitelist on enter and restores on leave. Wired today:
  - `pages/receiving/[id].vue` (order supplier)
  - `pages/put-away/[id].vue` (receiving-order supplier)
  - `pages/stock-search/index.vue` (selected supplier filter)
  Picking/measuring/goods-verify have no supplier context and are unaffected.
- **Failure policy**: symbology control is defense-in-depth on top of the existing
  template/matcher validation — all calls are fire-and-forget and must never block or fail
  a scan flow. Operations are serialized (module-level promise chain) so leave/enter
  transitions can't interleave.

## Risks

- App killed while restricted: restriction persists until next app start (restore at
  startup) or device reboot.
- The whitelist list must match the scanner app's resource strings verbatim; a firmware
  update that renames a string would silently no-op that entry (acceptable degradation).
