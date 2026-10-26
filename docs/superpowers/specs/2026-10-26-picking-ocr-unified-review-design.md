# Picking OCR unified item review — design

Date: 2026-10-26

## Problem

The unified picking page uses two OCR review experiences. A one-item capture opens the full form (part number, quantity, date code, lot code, COO and COW), while a capture with two or more matched order parts opens a part-number/quantity table. The multi-item path discards the other scanned fields, and weak substring matches can create unwanted rows on a one-item label. Operators cannot add a missing row in either experience.

The separate `pages/picking/scan/[id].vue` page is deprecated and will be removed rather than updated.

## Goals

- Use one review modal for every picking OCR capture, whether it contains zero, one, or several detected items.
- Every item has the full editable form and its own OCR candidates.
- Operators can add missing items and remove unwanted items, including extra automatically detected rows.
- Preserve per-item validation, immediate auto-apply, allocation splitting, batch validation, shelf-scan behavior and duplicate protection.
- Reduce phantom rows by excluding substring-only part matches from automatic multi-item detection.
- Leave receiving and put-away OCR behavior unchanged.

## Detection and parsing

Add a picking-specific draft extractor in `utils/parseOcrScan.ts`.

1. Parse the whole capture as today. If strong line-based detection finds fewer than two distinct order parts, return that one whole-label result. This preserves the existing single-label defaults and candidate chips.
2. Strong line-based detection accepts exact, supplier-prefix and OCR-substitution matches (score 80 or higher). A score-50 containment match does not automatically create a picking row. The existing `extractMultiItemRows` default remains unchanged for receiving and put-away.
3. When two or more strong rows exist, parse each contributing OCR line into a full item. Quantity, date code, lot code, COO and COW found on that line become the item's defaults. Whole-label values are appended as candidates, not blindly copied into every item.
4. Merge repeated detections of the same part on the captured label as today. Manually added rows may repeat a part.

## Review UI

Extend `components/picking/PickingScanReviewModal.vue` into a list of full-form item cards.

- The modal receives draft items, per-item candidate options, order part numbers and per-item apply results.
- Every unsucceeded item is editable and removable. **Add item** appends a blank full-form item.
- COO/COW keep the current behavior: initially empty, with scanned values available in the country dropdowns.
- Apply is enabled only when every pending item has a part number and positive integer quantity. It submits all pending valid items.
- Successful items lock and show success. Failed items remain editable and show their own error. Removing an item keeps the remaining result indices aligned.
- Retake, cancel, hardware-scanner gating and auto-apply remain unchanged.
- Disable editing and actions while an apply run is in progress to avoid duplicate submissions.

The shared `ScanMultiItemModal.vue` remains in use by put-away and is not changed. Receiving has its own multi-item modal and is also unchanged.

## Scan submission

The unified page submits each reviewed item through `session.handleParsed` as today, now preserving every `OcrInput` field. The raw duplicate key includes a stable draft row id rather than only the part number or display index, so two manually added rows for the same part remain distinct even after another row is removed.

No backend or API change is required. Client-side quantity, batch and shelf checks and the existing per-portion backend scan calls remain the authority.

## Deprecated route cleanup

Delete `pages/picking/scan/[id].vue`. Point the legacy detail page's Scan action to `/picking/unified/:id`, remove the deleted route from the work-lock route list, and update its test. Do not convert the deletion into the larger unified-detail route swap; that remains a separate change.

## Verification

- Parser tests: one-item full parsing, real multi-item full parsing, whole-label candidates without unsafe default copying, and rejection of substring-only phantom rows.
- Existing picking queue/session tests continue to pass, including same-part splitting, batch validation and shelf modes.
- Work-lock tests reflect the deleted route.
- Update the picking operator and AI documentation, code map and feature registry.
- Run the PDA Vitest suite, Nuxt type preparation and production build. Manually exercise browser OCR JSON for one-item, multi-item and manually added/removed rows when a backend is available.
