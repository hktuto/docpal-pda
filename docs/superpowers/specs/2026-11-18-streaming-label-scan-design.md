# Streaming label scan — camera auto-capture

Date: 2026-11-18
Status: design

## Background

Every camera label scan in the PDA app currently needs a deliberate user
action before anything is decoded: the operator aims the native camera
activity (`RectangleCameraActivity`), waits for OpenCV to track a rectangle
overlay, then **taps the rectangle or presses the shutter** — only then does
the crop go to ML Kit for OCR/barcode decoding. The tap → full-res capture →
crop → OCR chain costs roughly 1.5–3 s and needs a steady hand on the T23X /
NLS-MT95 devices.

Meanwhile the same activity **already runs a live analysis stream**:
CameraX `ImageAnalysis` at 480×640 with `STRATEGY_KEEP_ONLY_LATEST` feeds the
rectangle detector on every frame. The continuous-frame pipeline exists; only
ML Kit and an auto-fire decision are missing.

This spec adds a **streaming auto-capture mode**: while the camera is open,
frames are analyzed at an adaptive 100–300 ms cadence; when a decoded
candidate is stable and confident, the camera captures **one full-resolution
frame** and returns it through the existing contract — no tap, no shutter.

## Decision

`RectangleDetection.scanLabel()` gains an opt-in `{ stream: true }` option
(mobile only). In stream mode the activity:

1. Analyzes each incoming frame with **ML Kit barcode scanning every tick**
   and **ML Kit text recognition on a reduced tick rate** (OCR is ~3–5× the
   cost of barcode on this device class).
2. Self-paces to an **adaptive 100–300 ms interval** (target ≈ 0.75× the last
   measured analysis latency, clamped) and **drops frames while a decode is in
   flight** (`KEEP_ONLY_LATEST` + an `inFlight` guard).
3. Fires when the **stability gate** passes (see below), then grabs a
   full-res frame via `ImageCapture`, crops to the candidate region, runs one
   final ML Kit pass on the **high-res crop**, and finishes with the standard
   `LabelScanCapture` result.
4. Keeps **tap-rectangle and shutter capture fully working** as manual
   fallbacks, plus a ~20 s no-candidate hint.

Everything downstream of the capture (web-side `parseAndIdentify`,
`/scan/decode`, scan matchers, review modals) is **unchanged** — the result
contract `LabelScanCapture { imagePath, text, barcodes }` stays identical, so
all existing consumers work as-is.

### The stability gate (native, conservative)

Auto-fire requires **all** of:

- **Same signature on K consecutive candidate ticks** (K = 2 to start): exact
  value for barcodes; a normalized text signature (alphanumeric skeleton) for
  OCR. Kills blurs, motion smear, and the camera latching onto the wrong
  label while panning across a shelf.
- **Candidate prominence**: bounding-box area ≥ ~8 % of the frame and the
  box center inside the central region of the frame — the operator is
  pointing at this label.
- **OCR candidates additionally** must yield text ≥ 6 chars containing at
  least one digit (a light sanity check; the authoritative field parse stays
  on the web side).

Barcodes win over OCR: if a stable barcode exists it is the candidate (this
matches the web priority — QR-only captures go to `POST /scan/decode`, the
authoritative supplier-template decode). OCR is for TE/NCC-style labels.

The gate deliberately errs on the side of **not** firing. A false negative
just means the operator taps manually as today; a false positive costs a
wrong capture and a re-scan. Thresholds live in one `Options` block in
`StreamingLabelAnalyzer` for field tuning.

### Analyze low-res, capture high-res

Analysis runs on the 480×640 stream; the returned `imagePath` must remain a
high-quality evidence photo (the review modals render it — e.g.
`MeasureBox.vue` passes `review.capture.imagePath` to the review card). So
the auto-fire does **not** return a stream frame: it triggers one
`imageCapture.takePicture()` and crops that to the candidate box scaled from
stream coordinates (same scaleX/scaleY math as today's `processTapCapture`).

The returned `text`/`barcodes` come from one final ML Kit pass on the
**high-res crop** (better quality than the stream decode); if that pass fails
or returns empty, the stream values are used as fallback so a usable decode
never gets thrown away.

### Deployment / rollback safety

The web bundle updates with every deploy, but APKs in the field lag. Old
native code ignores unknown plugin options — `scanLabel({stream:true})` on an
old APK simply runs today's manual camera. Degradation is silent and safe;
no feature-detection handshake is required. Setting `stream:false` (or
omitting it) is byte-for-byte today's behavior.

## Native design

New/changed files under `apps/pda/android/app/src/main/java/com/docpal/warehousedemo/`:

- **`StreamingLabelAnalyzer.java`** (new) — implements
  `ImageAnalysis.Analyzer`. Holds **persistent** ML Kit clients
  (`BarcodeScanner`, `TextRecognizer`) for the activity lifetime —
  `OcrBarcodeProcessor` today creates fresh clients per call, which is fine
  for one-shot captures but must not happen per frame in a stream. Owns the
  cadence throttle, OCR skip counter, stability gate state, and candidate
  scoring; invokes a `CandidateListener` on the UI thread when the gate
  passes. Closes its clients from `onDestroy`.
- **`StreamingLabelGate.java`** (new, pure Java, no Android deps) — the
  stability/prominence state machine and cadence policy, extracted so it is
  unit-testable (mirrors `RectangleCropperOrderPointsTest`).
- **`RectangleCameraActivity.java`** — new `MODE_LABEL_SCAN_STREAM` intent
  mode: binds a single combined `ImageAnalysis` use case running
  `StreamingLabelAnalyzer` (the OpenCV rectangle overlay is **not** run in
  stream mode; the overlay instead highlights the current stable-candidate
  box from the analyzer). `onCandidate` → `captureMode = STREAM_CONFIRM` →
  `takePicture()` → `processStreamCapture()` (scale candidate box →
  `RectangleCropper.cropToFile` on the full-res frame → one `OcrBarcodeProcessor`
  pass → `RectangleOcrHelper.finishWithResult`). Adds a 20 s
  `postDelayed` "aim at a label, or tap to capture" hint. Tap/shutter paths
  untouched.
- **`RectangleDetectionPlugin.java`** — `scanLabel` reads
  `call.getBoolean("stream", false)` and passes it as an activity extra.
- `res/values/strings.xml` — hint/toast strings (activity currently
  hardcodes English toasts; new strings go in resources).

Threading: the analyzer runs on the existing single-thread
`analysisExecutor`; ML Kit callbacks fire elsewhere, so all gate state is
`volatile`/synchronized and the candidate hand-off posts to the main thread
(today's `runOnUiThread` pattern). While an async decode is in flight the
analyzer closes incoming frames immediately.

## Web design

- `composables/useRectangleDetection.ts` — `scanLabel(options?: { stream?: boolean })`;
  the browser fallback keeps throwing `SCAN_NOT_AVAILABLE_MESSAGE`.
- `composables/useLabelScan.ts` — `captureLabel()` calls
  `RectangleDetection.scanLabel({ stream: true })`. Cancellation and the
  browser prompt fallback are unchanged. No page-level changes anywhere
  (receiving, CN scan, put-away, ad-hoc, shelf exchange, internal transfer,
  picking unified, print-product-label, measuring/verify all consume the
  same capture contract).

## Performance expectations

Per 480×640 frame on the T23X-class hardware: ML Kit barcode ≈ 30–60 ms,
text recognition ≈ 100–300 ms. A 5–10 fps analysis rate with OCR on every
3rd tick is realistic; the adaptive clamp (100 ms floor / 300 ms ceiling)
keeps slow devices responsive without flooding fast ones. Scan sessions are
seconds long with torch on, so thermal/battery impact is negligible.

## Failure modes

- **Auto-fired capture unparseable on the web side** — handled by existing
  review/error paths; operator re-scans. Gate tuning (K, prominence, OCR
  sanity) is the mitigation, conservative by design.
- **Several labels in view** — largest/centermost stable candidate wins; a
  wrong pick is recoverable via the existing review card, same as a mis-tap
  today.
- **Glare / damaged label / no stable candidate** — 20 s hint toast; manual
  tap/shutter always available.
- **Old APK in the field** — silently runs manual mode (see deployment note).

## Testing

- `StreamingLabelGateTest.java` (new, `app/src/test/...`) — stability K-of-N,
  signature normalization, prominence scoring, cadence clamp, barcode-beats-
  OCR selection.
- `apps/pda/tests/useLabelScan.test.ts` — `captureLabel()` prefers
  `{stream:true}` and maps cancellation/browser fallback as today.
- Device verification on both scanner platforms (T23X / NLS-MT95): measure
  `[SCAN-TIME]` time-to-card against the manual path; tune gate constants.

## Non-goals

- No WebView/`getUserMedia` implementation — the whole stream is native; only
  the result crosses the bridge.
- No in-camera native candidate card (camera stays open with a live card fed
  by plugin events). v1 closes the camera, then the existing web review card
  appears; the live-card variant can follow later if operators want it.
- No changes to `parseOcrScan.ts`, `labelDecode.ts`, scan matchers, or the
  review modals.
- No multi-candidate accumulation across frames — one best candidate per
  auto-fire.
- No behavior change to the admin supplier-editor camera preview.

## Amendment 1 (2026-11-18) — rule confirm, stream-frame result, analysis size

Field feedback during device iteration (T23X):

- **Two identical OCR signatures is impractical** — OCR noise (`0`/`O`,
  dropped chars) resets the streak almost every tick.
- **Keyword confirm became named all-of rules** (loose any-of keywords were
  dropped): `rules: [{name, keywords[]}]` — ALL of one rule's keywords in a
  single decode fires immediately (streak and centre checks waived, 5%
  minimum-area gate stays); any rule can confirm, covering one brand's
  several label layouts. The result carries `matchedRule`. First wired
  context: ad-hoc put-away (KOA brand, KOA_LABEL_RULES in the page).
- **No full-res capture on fire.** The returned `imagePath` is the firing
  analysis frame saved as a JPEG (upright grayscale, analysis-stream
  resolution) — fire→JS is ~100 ms instead of ~0.5–1.5 s. The review modal
  accepts the lower-quality photo. `text`/`barcodes` come from the firing
  tick's stream decode; **all barcodes decoded on the firing tick ride
  along**, so 1D lot codes beside OCR text still reach `POST /scan/decode`.
- **`analysisSize: 'sd' | 'hd'`** plugin option selects the CameraX analysis
  stream resolution (480×640 default / 960×720 for small print; slower
  ticks, better OCR). Set from JS; no UI.
- **Torch defaults off in label-scan modes** — glare off glossy labels hurt
  OCR; the toggle button remains.
- **Timing instrumentation**: `STREAM-TIME` logs (activity open → first
  frame → gate fire) and a `[SCAN-TIME]` JS round-trip log. Measured on T23X:
  camera open ≈ 1.2–1.5 s per scan (CameraX bind; dominant cost), decode→fire
  ≈ 0.4–1 s, fire→JS ≈ 0.1 s. ML Kit warm-up threading was tried and
  **reverted** (contended with camera startup on the weak SoC); OCR now runs
  on the first analyzed tick and every 2nd tick after (`ocrEvery = 2`).

Known floor: per-scan camera-activity startup bounds single-shot scans at
~1.5–2 s. A continuous scan mode (camera stays open, results stream to JS
via plugin events) is the planned follow-up to amortize it.

## Parked for later design

- **Server-side OCR decode** (`POST /scan/decode-ocr`): port
  `utils/parseOcrScan.ts` into `src/decode/`, resolve parts via
  `lookupPartKeyCandidates` / drawing-no / MPN branches, return ranked part
  candidates for the native preview card and post-capture enrichment.
- **Native preview card** (Phase 2): in-camera decoded-fields display.
