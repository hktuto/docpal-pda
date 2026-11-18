# Streaming label scan — status & next steps

Date: 2026-11-18
Branch: `feat/streaming-label-scan`
Design spec: `2026-11-18-streaming-label-scan-design.md` (with Amendment 1)
Plan: `2026-11-18-streaming-label-scan.md`

This is the session handoff: what shipped, what was tried (with T23X
measurements), and what is parked pending design.

## Shipped on this branch

**Native (`apps/pda/android/.../com/docpal/warehousedemo/`)**
- `StreamingLabelAnalyzer.java` — CameraX analysis-stream analyzer:
  persistent ML Kit barcode scanner + text recognizer, adaptive 100–300 ms
  cadence, barcode every tick, OCR on the first tick and every 2nd after.
  Saves the firing frame as a JPEG; passes the firing tick's full barcode
  list + matched rule to the listener.
- `StreamingLabelGate.java` — pure-Java confirm policy (21 unit tests):
  - **Rule path**: ALL of a named rule's keywords (`rules:[{name,keywords}]`)
    in one decode fires immediately — streak and centre checks waived, 5%
    minimum-area gate stays. Any rule can confirm (multiple label layouts
    per brand). `matchedRuleName()` names the winner.
  - **Fallback path**: 2-tick stable signature + prominence (≥8% area,
    centred) + OCR sanity (≥6 chars with a digit).
- `RectangleCameraActivity` stream mode (`label_scan_stream`) — torch
  defaults OFF for label scans (glare hurt OCR; toggle stays), 20 s manual
  hint, shutter fallback, `STREAM-TIME` instrumentation logs.
- `RectangleDetectionPlugin.scanLabel({stream, rules, analysisSize})` —
  `analysisSize: 'sd'|'hd'` picks 480×640 / 960×720 analysis stream.
- Result: `{imagePath, text, barcodes, matchedRule?}` — imagePath is the
  grayscale firing frame (no full-res capture); barcodes includes every
  barcode decoded on the firing tick (1D lot codes beside OCR text).

**Web (`apps/pda`)**
- `useRectangleDetection.ts` — `ScanRule` type, options, `matchedRule`.
- `useLabelScan.ts` — `captureLabel({rules, analysisSize})`;
  `[SCAN-TIME]` round-trip + `[SCAN-RESULT]` logs.
- `pages/ad-hoc-put-away/index.vue` — KOA wired only: `KOA_LABEL_RULES`
  (`reel: KOA+1000PCS`, `box: KOA+R47`) + `analysisSize:'hd'`. Rules are
  page-editable; hot-reload applies, no reinstall needed.
- Tests: 21 gate unit tests + 479 vitest green.

## Tried — with measurements (T23X, debug build)

| Experiment | Result | Verdict |
| --- | --- | --- |
| Full-res capture + crop + hi-res re-decode on fire | fire→JS ~0.5–1.5 s | replaced |
| Stream frame as result photo, tick barcodes | fire→JS ~0.1 s | **kept** |
| ML Kit warm-up on a side thread | warm open→first-tick 1220→1480 ms | **reverted** (SoC contention) |
| OCR every 3rd tick | first OCR chance delayed 1–2 ticks | changed: first tick + every 2nd |
| Loose any-of keywords | OCR noise (`UANTITY`, `KON`, `SAPAN`) resets signature streaks | replaced by all-of rules on stable strings |
| `hd` 960×720 analysis | wired for KOA A/B | pending field evaluation of small-print hit rate |
| Timing breakdown per scan | open→first-tick 1.2–1.5 s (CameraX bind, dominant, ~60%); first-tick→fire 0.4–1 s (OCR lottery); fire→JS ~0.1 s | instrumentation kept |

Measured single-shot total: ~1.6–2.2 s best case.

## Caveats on this branch

- Ad-hoc page carries session debug lines — including
  `prompt(JSON.stringify(capture))` — remove when revisiting.
- The device has a debug build installed (localhost dev-server config).
- `ocrEvery`, `keywordMinAreaRatio`, rules' keyword lists are first-cut
  values from one session; field-tune before wider rollout.
- NLS-MT95 not tested yet.

## Next (parked, needs design)

1. **Server-side OCR decode API** (`POST /scan/decode-ocr`): port
   `apps/pda/utils/parseOcrScan.ts` (~684 lines + normalizer) into
   `apps/backend/src/decode/`, resolve parts with the existing
   `lookupPartKeyCandidates` (pg_trgm fuzzy) + drawing-no / MPN branches,
   return ranked `{partNo, wclItemNo, description, score, basis}` candidates.
   Open questions: public vs JWT (mirror `/scan/decode` public + rate
   limit?), candidate limit / similarity threshold, first consumer.
   Note: master gained `POST /scan/part-details` (586e33c0) while this
   branch was in progress — build on it when designing.
2. **Native preview card** (Phase 2): in-camera decoded-fields display fed
   by (1); JS decides / native renders (JS UI is invisible under the camera
   activity).
3. **Continuous scan mode**: keep the camera open across scans in batch
   flows (ad-hoc), results via plugin events — the only way below the
   ~1.2 s/scan CameraX bind floor.
4. **Wider rule wiring**: receiving (`supplierCode`), print-product-label
   (brand), other flows — only ad-hoc is done.
5. **Commit cleanup**: strip debug lines; decide default `analysisSize`.
