# Scan review raw OCR text display

## Goal

Make the raw OCR text visible in the shared scan review modal so operators can read, search, and copy the OCR output before deciding whether to apply or retake the scan.

## Background

The app uses OpenCV to crop a label and then runs OCR. The scan review modal (`components/LabelScanReviewModal.vue`) already receives the raw OCR string as a `text` prop from `useLabelScan`, but it only shows the parsed fields (part no, date code, lot code, COO, COW, qty). Operators have no easy way to see the full OCR result.

## Scope

This is a single-component, read-only UI change.

- Add the raw OCR text box to `components/LabelScanReviewModal.vue`.
- Because every scan flow (picking, receiving, put-away, measuring, goods-verify) uses this modal, the change applies to all of them automatically.
- No changes to OCR logic, parsing, matching, or database.

## Design

### Placement

Insert the raw OCR box in `components/LabelScanReviewModal.vue` between the image preview and the editable OCR fields.

### UI

- Label: **"OCR raw text"**
- Control: `<textarea readonly>` containing `props.text`
- The textarea is scrollable and selectable so it can be copied/searched on mobile.
- It is never editable; the existing parsed fields remain the editable inputs.

### Styling

Match the existing modal field styles:

- Full width.
- `min-height: 4rem` to show a few lines.
- Monospace font (`font-family: ui-monospace, monospace`) to preserve spacing and make OCR output easier to read.
- Light background (`var(--bg)`) to distinguish it from editable inputs.

### Behavior

- No state management: the box displays the `text` prop directly.
- No validation or conditional logic.
- If `text` is empty, the textarea is empty.

## Testing

1. `pnpm nuxt prepare` — types generate without errors.
2. Manual browser test:
   - Trigger a scan in any flow (e.g. picking detail → Scan).
   - When the review modal opens, confirm a read-only "OCR raw text" box appears below the captured image.
   - Confirm the box contains the raw OCR string and is scrollable/selectable.

## Migration / compatibility

No schema or data migration is required. Existing scan flows receive the `text` prop already.
