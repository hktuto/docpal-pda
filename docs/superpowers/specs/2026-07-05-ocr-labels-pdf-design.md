# OCR Labels PDF Generation

## Goal

Provide a printable A4 PDF of the demo scan-step labels from `public/ocr-labels.html`, committed to the repo as `public/ocr-labels.pdf` so it can be downloaded directly.

## Context

`public/ocr-labels.html` is a standalone demo page that renders 11 KOA-style labels across workflow Steps 3 (picking), 5 (measuring/verify), and 6 (put-away). Each label contains part numbers, quantities, trace/date codes, barcodes, and QR codes generated client-side by JsBarcode and QRCode libraries.

The page already has basic `@media print` styles, but it prints one label per page and includes non-label step chrome. We need a reproducible, committed PDF with only the labels, 2–3 per A4 page.

## Design

### Approach

Use Playwright in a Node.js script to render the existing HTML page, inject a print-optimized stylesheet, wait for barcodes and QR codes to render, then export a PDF.

### Files

- `scripts/generate-ocr-labels-pdf.mjs` — generation script.
- `public/ocr-labels.pdf` — generated output (committed).

### Generation flow

1. Launch headless Chromium via Playwright.
2. Load `file:///<repo>/public/ocr-labels.html`.
3. Wait for `.barcode` and `.qr-placeholder` elements to be populated.
4. Inject a `<style>` block that:
   - Hides `.no-print` and `.step__header` / `.step__body` chrome.
   - Flattens `.step__labels` containers into a single flex/grid list.
   - Sizes each `.label` to fit 2–3 per A4 portrait page.
   - Keeps label styling, barcodes, and QR codes intact.
5. Call `page.pdf({ path: 'public/ocr-labels.pdf', format: 'A4', printBackground: true })`.
6. Close the browser.

### Layout

- Paper: A4 portrait.
- Margins: 10 mm on all sides.
- Label list laid out as a CSS flex column with `page-break-inside: avoid`.
- Each label targets roughly 90 mm high so 2–3 fit comfortably per page.

### Dependencies

- `playwright` as a dev dependency (used only by the generation script).

### Convenience

- Add `generate:ocr-labels-pdf` script to `package.json`:
  ```json
  "generate:ocr-labels-pdf": "node scripts/generate-ocr-labels-pdf.mjs"
  ```

### Regeneration

When `public/ocr-labels.html` changes, run:

```bash
pnpm generate:ocr-labels-pdf
```

Then commit the updated `public/ocr-labels.pdf`.

## Out of scope

- Dynamic PDF generation at runtime.
- PDF generation in CI.
- Layouts other than A4 portrait with 2–3 labels per page.
- Non-KOA label styles from `ocr-labels-backup.html`.

## Success criteria

- `public/ocr-labels.pdf` exists and can be opened in a PDF viewer.
- PDF contains all 11 scan-step labels.
- Barcodes and QR codes are rendered and scannable.
- Labels are readable at 2–3 per A4 page.
- `pnpm generate:ocr-labels-pdf` regenerates the file successfully.
