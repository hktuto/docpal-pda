# Ponytail cleanup — Implementation Plan

> Scope: apply the ponytail-audit findings except the `uuid → crypto.randomUUID()` replacement, which the user wants to keep as-is.

**Goal:** Remove dead demo code, unused dependencies, redundant wrappers, and native code paths that are no longer reachable after the reusable label-scan flow shipped.

**Estimated impact:** ~-1800 lines, -7 dependencies.

---

## Task 1: Delete demo pages and demo-only support code

**Why:** These pages are no longer linked from the home menu and exist only to support features the production flow no longer uses.

**Delete:**
- `pages/ocr-demo.vue`
- `pages/document-scanner-demo.vue`
- `pages/object-detection-demo.vue`
- `pages/opencv-rectangle-demo.vue`
- `pages/subject-segmentation-demo.vue`
- `composables/useCameraOcr.ts`
- `composables/useMlKitOcr.ts`
- `composables/useDocumentScanner.ts`
- `composables/useObjectDetection.ts`
- `composables/useSubjectSegmentation.ts`
- `components/OcrCameraModal.vue`
- `public/ocr-labels.html`

**Verification:**
- `grep -r "useCameraOcr\|useMlKitOcr\|useDocumentScanner\|useObjectDetection\|useSubjectSegmentation\|OcrCameraModal\|ocr-labels" composables/ components/ pages/ public/` returns nothing.
- `pnpm nuxt prepare` passes.

---

## Task 2: Delete demo-only Capacitor plugin dependencies

**Why:** The remaining production flow uses the native `RectangleCameraActivity` + ML Kit directly; these Capacitor wrappers are only referenced by the deleted demos.

**Remove from `package.json`:**
- `@capacitor/camera`
- `@capgo/capacitor-document-scanner`
- `@pantrist/capacitor-plugin-ml-kit-text-recognition`
- `@capacitor-mlkit/subject-segmentation`

**Also delete:**
- `patches/@pantrist__capacitor-plugin-ml-kit-text-recognition@8.0.0.patch`
- `patches/@capacitor-mlkit__subject-segmentation@8.1.0.patch`

**Verification:**
- `pnpm install` completes.
- `pnpm nuxt prepare` passes.
- Android sync still works (`npx cap sync android`).

---

## Task 3: Delete Android `ObjectDetectionPlugin`

**Why:** Only served the object-detection demo.

**Delete:**
- `android/app/src/main/java/com/docpal/warehousedemo/ObjectDetectionPlugin.java`

**Modify:**
- `android/app/src/main/java/com/docpal/warehousedemo/MainActivity.java` — remove the `ObjectDetectionPlugin.class` registration from `onCreate`.
- `android/app/build.gradle` — remove the `com.google.mlkit:object-detection` dependency if it was added only for this plugin.

**Verification:**
- `./gradlew :app:assembleDebug` compiles.

---

## Task 4: Delete `useOcrPicking` composable

**Why:** Superseded by `useLabelScan` + `useScanMatchers`; no production code imports it.

**Delete:**
- `composables/useOcrPicking.ts`

**Verification:**
- `grep -r "useOcrPicking" composables/ pages/ components/` returns nothing (docs/README are okay).
- `pnpm nuxt prepare` passes.

---

## Task 5: Remove unused `RectangleDetection` methods and wrapper

**Why:** Only `scanLabel()` is used in production. `detectRectangles` and `startCameraStream` were demo-only, and `useRectangleDetection()` is a thin wrapper that no longer adds value.

**Modify:**
- `composables/useRectangleDetection.ts` — keep the `RectangleDetection` plugin export; delete the `useRectangleDetection()` wrapper and the unused `DetectRectanglesOptions`, `DetectRectanglesResult`, `DetectedRectangle`, `Point`, `RectangleBoundingBox`, `CameraStreamCaptureResult` types if no longer referenced.
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleDetectionPlugin.java` — delete `detectRectangles()` and `startCameraStream()` plugin methods and their callbacks.
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java` — delete the default stream mode code path if it becomes unreachable.

**Verification:**
- `grep -r "detectRectangles\|startCameraStream\|useRectangleDetection" composables/ pages/ components/` returns nothing.
- `./gradlew :app:assembleDebug` compiles.

---

## Task 6: Remove unused `@electric-sql/pglite-vue` and `sass` dependencies

**Why:** `useLiveQuery` is unused, and only one file uses SCSS for a single nested rule.

**Modify:**
- `package.json` — remove `@electric-sql/pglite-vue` and `sass`.
- `layouts/default.vue` — convert the scoped `<style lang="scss">` block to plain CSS.

**Verification:**
- `pnpm install` + `pnpm nuxt prepare` pass.

---

## Task 7: Trim native debug code from `RectangleCameraActivity`

**Why:** Debug helpers and FPS overlay are not needed for the production label-scan flow.

**Modify:**
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleCameraActivity.java` — remove `saveDebugBytes`, `saveDebugMat`, FPS averaging, and FPS overlay drawing.

**Verification:**
- `./gradlew :app:assembleDebug` compiles.

---

## Task 8: Delete unused `RectangleCropper` methods

**Why:** Only `cropToFile` and `matToFile` are used.

**Modify:**
- `android/app/src/main/java/com/docpal/warehousedemo/RectangleCropper.java` — remove `cropToBase64` and `matToBase64`.

**Verification:**
- `./gradlew :app:assembleDebug` compiles.

---

## Task 9: Extract shared `getIsoWeek` helper

**Why:** Same ISO-week logic exists in `db/picking.ts` and `db/putAway.ts`.

**Modify:**
- Create `db/date.ts` exporting `getIsoWeek(date: Date): number`.
- Replace the inline copies in `db/picking.ts` and `db/putAway.ts` with imports from `db/date.ts`.

**Verification:**
- `pnpm nuxt prepare` passes.

---

## Task 10: Extract shared `runScanMatcher` helper

**Why:** `useLabelScan.ts` and `LabelScanReviewModal.vue` duplicate the same `switch (context.task)` matcher dispatch.

**Modify:**
- Add `runScanMatcher(ctx: ScanTaskContext, parsed: OcrInput): Promise<ScanMatchResult>` to `composables/useScanMatchers.ts`.
- Replace the duplicated switch blocks in `useLabelScan.ts` and `LabelScanReviewModal.vue` with calls to `runScanMatcher`.

**Verification:**
- `pnpm nuxt prepare` passes.

---

## Task 11: Remove small dead code / nit fixes

**Modify:**
- `pages/receiving/[id].vue` — remove unused `noopDecoder` import.
- `pages/login.vue` — remove the dead "Forgot password?" link (it has `@click.prevent` and does nothing).
- `pages/goods-verify/box/[id].vue` — simplify `openScanFor(item)` to `openScan()` since the argument is ignored.

**Verification:**
- `pnpm nuxt prepare` passes.

---

## Task 12: Final verification

- [ ] `pnpm nuxt prepare` passes.
- [ ] `./gradlew :app:testDebugUnitTest` passes.
- [ ] `./gradlew :app:assembleDebug` compiles.
- [ ] `pnpm generate` + `npx cap sync android` complete.
- [ ] `./gradlew :app:installDebug` installs on the connected device.

---

## Excluded finding

- `uuid` dependency — user explicitly wants to keep `uuid()` as-is.
