# Streaming label scan — implementation plan

Spec: `docs/superpowers/specs/2026-11-18-streaming-label-scan-design.md`

Order: native gate (pure Java + tests) → analyzer → activity + plugin → web
contract → web tests → device tuning → docs/UAT → verify → commit.

## 1. Native gate — `StreamingLabelGate.java` (new)

`apps/pda/android/app/src/main/java/com/docpal/warehousedemo/StreamingLabelGate.java` —
pure Java, no Android imports:

- `static class Candidate { String signature; String value; Rect-like box
  (left/top/right/top as ints, plain fields); boolean isBarcode; }`
- `static class Options` — `stableFrames = 2`, `minAreaRatio = 0.08`,
  `centerMarginRatio = 0.25`, `minOcrLen = 6`, `minIntervalMs = 100`,
  `maxIntervalMs = 300`, `ocrEvery = 3`.
- `boolean shouldAnalyze(long nowMs, long lastStartMs, long lastLatencyMs)` —
  adaptive interval `clamp(lastLatencyMs * 3 / 4, min, max)` vs elapsed.
- `void onTick(Candidate candidate)` / `void onNoCandidate()` — updates the
  same-signature streak; resets on change/absence.
- `Candidate fireCandidate()` — non-null once the streak ≥ `stableFrames`
  and prominence passes; barcode candidates supersede OCR ones.
- OCR text sanity helper `static boolean plausibleLabelText(String)` —
  len ≥ `minOcrLen` + contains a digit.
- Signature helper `static String signatureFor(String value, boolean
  isBarcode)` — barcode: raw value; OCR: uppercase alphanumeric skeleton.

## 2. Gate unit tests — `StreamingLabelGateTest.java` (new)

`apps/pda/android/app/src/test/java/com/docpal/warehousedemo/` (JUnit4, same
style as `RectangleCropperOrderPointsTest`):

- K-of-N stability: fires on 2nd consecutive same signature; resets on
  change; resets on gap frame.
- Prominence: small box and off-center box do not fire.
- Barcode supersedes OCR when both stable.
- `shouldAnalyze` clamp behaviour (fast device → floor; slow → ceiling).
- `plausibleLabelText` accepts "ABC123", rejects "AB", "abcdefg".

Run: `cd apps/pda/android && ./gradlew :app:testDebugUnitTest`.

## 3. `StreamingLabelAnalyzer.java` (new)

`ImageAnalysis.Analyzer` bound to the existing `analysisExecutor`:

- Owns **persistent** `BarcodeScanner` + `TextRecognizer` clients (do NOT
  reuse `OcrBarcodeProcessor` per frame — it rebuilds clients per call;
  mirror its ML Kit wiring instead); `close()` from activity `onDestroy`.
- `analyze()`: if `inFlight`, `image.close()` + return. Else build
  `InputImage` from the Y plane (same YUV→Mat path as `RectangleAnalyzer`;
  ML Kit accepts the `media.Image` directly via `InputImage.fromMediaImage`
  before `close()`), fire barcode every tick and OCR when
  `tick % ocrEvery == 0`, set `inFlight` until both launched tasks settle.
- On each result tick: hand candidate (value + bounding box + kind) to
  `StreamingLabelGate`; when the gate fires, post `CandidateListener.onCandidate`
  on the main thread **once** (latch; analyzer keeps running but the listener
  is single-shot — the activity is now capturing).
- Maps ML Kit `Barcode.getBoundingBox()` / `Text.getBoundingBox()` into
  stream coordinates (rotate degrees applied, same `rotateMat` convention).

## 4. `RectangleCameraActivity.java` — stream mode

- New `MODE_LABEL_SCAN_STREAM` extra; `streamMode` flag from
  `getIntent().getBooleanExtra`. In stream mode `bindCamera()` attaches ONE
  `ImageAnalysis` running `StreamingLabelAnalyzer` instead of
  `RectangleAnalyzer` (keep rect overlay for manual modes as-is).
- Overlay: add `overlayView.setHighlightRect(box)` (single-rect path in
  `RectangleOverlayView`, styled like tracked rects) driven by
  analyzer candidate ticks; clear on no-candidate.
- `onCandidate(Candidate)` → if `captureMode != NONE` ignore; else
  `captureMode = STREAM_CONFIRM` → `takePicture()` (reuse).
- `processCapturedImage` gains the `STREAM_CONFIRM` branch →
  `processStreamCapture(rotated, w, h, candidate)`:
  scale candidate box by `originalWidth/streamWidth` (same math as
  `processTapCapture`) → `RectangleCropper.cropToFile(..., JPEG_QUALITY,
  getCacheDir(), CAPTURE_FILE_PREFIX + "stream_")` → one
  `ocrHelper.runOcrAndFinish(...)` on the crop (existing helper already runs
  ML Kit + finishes; pass the stream `barcodesJson`/`text` through a small
  extension so empty hi-res results fall back to stream values per spec).
- 20 s `postDelayed` hint toast (`stream_hint_manual_fallback` string) when
  no candidate has fired; cancelled on fire/destroy.
- `onDestroy`: close analyzer clients + remove callbacks.

## 5. Plugin + TS contract

- `RectangleDetectionPlugin.java` — `scanLabel`: `boolean stream =
  call.getBoolean("stream", false);` → `intent.putExtra(EXTRA_MODE, stream ?
  MODE_LABEL_SCAN_STREAM : MODE_LABEL_SCAN)`.
- `useRectangleDetection.ts` — `ScanLabelOptions { stream?: boolean }`,
  `scanLabel(options?: ScanLabelOptions)`; browser fallback unchanged.
- `useLabelScan.ts` — `captureLabel()` → `RectangleDetection.scanLabel({
  stream: true })`; cancellation/browser-fallback branches untouched.

## 6. PDA tests

- `apps/pda/tests/useLabelScan.test.ts` — extend: `captureLabel()` calls
  scanLabel with `{ stream: true }`; cancellation still maps to null;
  browser fallback still prompts. Mock the plugin module.

## 7. Device tuning (both scanner platforms)

- Install debug APK on T23X + NLS-MT95 (`./gradlew :app:installDebug` with
  `JAVA_HOME` per AGENTS.md). Exercise camera scan on real supplier labels:
  QR labels (expect card in ~0.5–1 s), TE/NCC OCR labels. Tune
  `StreamingLabelGate.Options` (K, `ocrEvery`, `minAreaRatio`,
  interval clamp) in one place; watch `adb logcat -s RectangleCamera` for
  per-tick latency. Confirm: torch, timeout hint, tap/shutter fallback,
  old-mode parity (`stream:false`).

## 8. Docs + UAT

- `docs/dev-guide-zh/` scan-flow docs + `docs/app-docs/flows/*/ai-scope.md`
  (receiving, put-away, picking): note the camera auto-capture mode.
- `docs/uat/features/CR-<next>.json` — feature record against the affected
  scan functions (PDA-006 receiving detail, PDA-008 CN scan, PDA-010 put-away
  detail, PDA-011, PDA-012, PDA-014, measuring/verify), then
  `node scripts/gen-uat-xlsx.mjs`.

## 9. Verify

- `./gradlew :app:testDebugUnitTest` (gate tests pass).
- `pnpm --filter @warehouse/pda test` && `pnpm --filter @warehouse/pda nuxt
  prepare`.
- Manual device pass per §7.

## 10. Commit

`feat(pda): streaming auto-capture label scan — camera decodes while aiming,
auto-fires on stable candidate (native ML Kit stream + stability gate)`
