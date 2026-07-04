# useLabelScan

`composables/useLabelScan.ts`

Parses scanned or typed label input into structured fields (part number, quantity, date/lot code, origin).

## When to use

Use this composable when building a scan/label-entry feature.

## Main responsibilities

- Accept raw input text.
- Normalize common OCR substitutions.
- Return structured label fields.
- Expose validation helpers.

## Related files

- `composables/useScanMatchers.ts`
- `composables/useMockOcr.ts`
- `components/LabelScanReviewModal.vue`
