# Supplier barcode-type whitelist → PDA scanner symbology control

## Goal

Add a per-supplier "accepted barcode types" whitelist to `supplier_profiles`. When a scan
screen knows the supplier (receiving detail, put-away detail, stock-search with supplier
filter), the web app restricts the hardware scanner to those symbologies via the device's
exported broadcast API, so other barcodes on a multi-barcode label are ignored by the
decoder itself. Leaving the screen restores the full symbology set.

## Proven device API (verified on the Movfast T23X this session)

- `com.xcheng.scannere3/.ScanTestReceiver` (exported) accepts:
  - `com.xcheng.scanner.action.ENABLE_SCANTYPE_BROADCAST`
  - `com.xcheng.scanner.action.DISABLE_SCANTYPE_BROADCAST`
  - string extra `scantype` = the settings app's display name, e.g. `"Code128"`, `"QR CODE"`.
- Verified live: `DISABLE Code128` made a Code128 scan produce no decode; `ENABLE` restored it.
- Runtime-only and device-global: not written to the scanner app's SharedPreferences, so the
  settings UI doesn't reflect it and a reboot restores saved config. Our app must re-apply on
  screen enter and restore on leave.
- IMPORTANT: valid `scantype` values are the settings app's localized display strings
  (`isValidType` in ScanTestReceiver compares `context.getString(resId).equals(str)`), e.g.
  QR is `"QR CODE"` (with space), NOT `"QRCODE"`. The canonical list must be built from those
  resource strings (extract from the pulled APK
  `.kimi-code/tmp/scanner-apks/ScannerE3_Code.apk` resources / BarcodeType list) and each entry
  smoke-tested on-device with an `am broadcast` round-trip.

## Decisions (confirmed with user)

- Whitelist semantics: set = only these symbologies decode, all others disabled;
  empty/unset = no change (device default).
- Apply on all scan screens where a supplier is resolvable; screens without a supplier
  context (picking, measuring) are unaffected.

## Steps

### 0. Spec/plan docs (repo feature workflow)
- `docs/superpowers/specs/2026-09-04-supplier-barcode-type-whitelist-design.md` — short spec
  (device API findings above, schema, semantics, restore behavior).
- `docs/superpowers/plans/2026-09-04-supplier-barcode-type-whitelist.md` — mirrors this plan.

### 1. Backend (`apps/backend`)
- `src/db/schema/master.ts`: add to `supplierProfiles`:
  `barcodeTypes: text("barcode_types").array()` (nullable; null = no restriction — mirrors
  `shelves.subInventoryCodes` precedent).
- `pnpm --filter @warehouse/backend db:generate` → migration; auto-applies on startup.
- `src/routes/admin/index.ts` supplier-profiles CRUD: accept `barcodeTypes` via existing
  `optStrArray` in `create` and `update`.
- `src/db/scantemplates.ts`: add `barcodeTypes: string[] | null` to `ScanTemplateRow` and the
  SQL (`barcode_types AS "barcodeTypes"`). This endpoint is the existing client channel for
  per-supplier scan config, already fetched+cached by `useLabelScan.ts`.
- Update `src/db/scantemplates.test.ts` to cover the new column.

### 2. Web — native plugin (`apps/web`)
- New `android/app/src/main/java/com/docpal/warehousedemo/ScannerConfigPlugin.java`:
  - `@CapacitorPlugin(name = "ScannerConfig")`, method
    `setSymbologies({ enabled: JSArray })`: sends ENABLE broadcast for each entry in
    `enabled`, DISABLE for each entry in `ALL_SYMBOLOGIES − enabled`, explicit component
    `com.xcheng.scannere3/.ScanTestReceiver`, extra `scantype`.
  - Method `restoreAll()`: ENABLE for every entry in `ALL_SYMBOLOGIES`.
  - `ALL_SYMBOLOGIES` = the display-name list (from step 1 of verification below).
  - No-op-safe on non-xcheng devices: broadcasts to an absent package are harmless.
- Register in `MainActivity.java` (`registerPlugin(ScannerConfigPlugin.class)`).
- New TS bridge `composables/useScannerConfig.ts`: `registerPlugin<ScannerConfigPlugin>`
  with a web stub whose methods resolve immediately (same pattern as `useScannerBroadcast.ts`).

### 3. Web — scope composable
- New `composables/useSupplierSymbologyScope.ts`:
  - Input: `Ref<string | undefined>` supplier code.
  - Resolves the supplier's `barcodeTypes` via the scan-templates list (reuse/extend the
    cached `getCachedSupplierQrTemplates` in `useLabelScan.ts` — move the cache into
    `useScannerConfig.ts` or a small shared module so both use it; extend
    `SupplierQrcodeTemplate` in `services/types.ts` + the mapping in
    `services/adapters/backendWarehouse.ts:getSupplierQrTemplates` with `barcodeTypes`).
  - `watch` the supplier code: if the profile has a non-empty whitelist →
    `ScannerConfig.setSymbologies({enabled: whitelist})`; otherwise → `restoreAll()`.
  - `onUnmounted` → `restoreAll()` (runtime-only setting; restore on leave).
  - All calls fire-and-forget with `.catch` logging — symbology control must never block or
    fail a scan flow (it is defense-in-depth on top of the existing template/matcher checks).
- App-start crash-recovery: call `restoreAll()` once in `app.vue` setup (covers the app dying
  while a restriction was active).

### 4. Web — page wiring
- `pages/receiving/[id].vue`: `useSupplierSymbologyScope(computed(() => order.value?.supplier?.code))`.
- `pages/put-away/[id].vue`: same with its `order.value?.supplier?.code` (already used at
  line ~255).
- `pages/stock-search/index.vue`: same with `selectedSupplierCode`.
- No changes to picking/measuring/goods-verify (no supplier context).

### 5. Admin UI (`apps/admin`)
- `components/QrTemplateEditorDialog.vue`: add a "Barcode types" section — checkbox grid of
  the symbology display names (shared constant; none checked = no restriction), bound to
  `profile.barcodeTypes`.
- `pages/suppliers.vue`: include `barcodeTypes` in the profile save payload.
- i18n labels in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`.

### 6. Docs maintenance
- `docs/app-docs/` — update the receiving flow `ai-scope.md`/`overview.md` and
  `ai/feature-registry.md` + `ai/code-map.md` for the new files (per repo doc rules).
- `docs/backend/schema-tables.md` — add `barcode_types` to the supplier_profiles entry.
- AGENTS.md scan-broadcast note: mention the symbology-control broadcasts alongside the
  existing ScannerBroadcast setup paragraph.

### 7. Verification
1. Extract + on-device verify the full `scantype` display-name list first (batch
   `am broadcast … DISABLE/ENABLE` per name, confirm via settings screen toggle state for a
   couple of them).
2. `pnpm --filter @warehouse/backend test` and `pnpm --filter @warehouse/backend build`.
3. `pnpm --filter @warehouse/web test`; `pnpm --filter @warehouse/web nuxt prepare`.
4. Admin: set a whitelist (e.g. `QR CODE` only) on the demo supplier, confirm it persists.
5. Device end-to-end: bundled APK (`NUXT_PUBLIC_API_BASE_URL=… pnpm generate` →
   `node scripts/cap-android-bundled.mjs` → gradlew installDebug), open a receiving order for
   that supplier, confirm a Code128 label no longer decodes and a QR does; leave the page and
   confirm Code128 decodes again. `adb logcat -s ScannerConfig` to watch the broadcasts.

## Notes / risks

- Runtime-only setting: if the app is killed mid-screen the restriction persists until the
  app restarts (app-start `restoreAll`) or the device reboots (decoder re-inits from saved
  prefs). Acceptable; the operator can also fix it in the scanner settings app.
- Broadcasts are device-global — two apps can't fight over it in practice (only the PDA app
  scans), but the restore-on-leave discipline keeps the device neutral when our app isn't
  actively in a supplier context.
- The whitelist narrows the *hardware decoder*; the existing supplier `qr_template` regex and
  scan matchers remain the authoritative validation layer.
