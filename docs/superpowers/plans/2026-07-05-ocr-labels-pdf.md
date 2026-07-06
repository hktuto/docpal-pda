# OCR Labels PDF Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a committed A4 PDF of the scan-step labels from `public/ocr-labels.html` using Playwright.

**Architecture:** A Node.js script loads the existing HTML page in a headless browser, waits for client-side barcodes/QR codes, injects print-optimized CSS to fit 2–3 labels per A4 page, and exports `public/ocr-labels.pdf`.

**Tech Stack:** Node.js, Playwright, JsBarcode (already in page), QRCode (already in page).

---

### Task 1: Install Playwright dev dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add Playwright to dev dependencies**

```bash
pnpm add -D playwright
```

- [ ] **Step 2: Verify install**

Run: `pnpm list playwright`
Expected: `playwright x.x.x` listed under devDependencies.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
pnpm lockfile not modified if using pnpm — verify with git status
git commit -m "chore(deps): add playwright for ocr-labels pdf generation"
```

---

### Task 2: Add PDF generation script

**Files:**
- Create: `scripts/generate-ocr-labels-pdf.mjs`

- [ ] **Step 1: Write the script**

```javascript
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const htmlPath = join(repoRoot, 'public', 'ocr-labels.html');
const outputPath = join(repoRoot, 'public', 'ocr-labels.pdf');

async function generate() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(`file://${htmlPath}`);

  // Wait for barcodes and QR codes to render.
  await page.waitForFunction(() => {
    const barcodes = document.querySelectorAll('.barcode');
    const qrs = document.querySelectorAll('.qr-placeholder svg');
    return barcodes.length > 0 && qrs.length > 0;
  });

  // Inject print-optimized CSS for A4, 2-3 labels per page.
  await page.addStyleTag({
    content: `
      @page { size: A4 portrait; margin: 10mm; }
      body { background: #fff; padding: 0; }
      .no-print, .step__header, .step__body { display: none !important; }
      .container { max-width: none; display: flex; flex-direction: column; gap: 8mm; }
      .step { border: none; box-shadow: none; padding: 0; page-break-inside: avoid; }
      .step__labels { display: flex; flex-direction: column; gap: 8mm; }
      .label {
        width: 100%;
        min-height: 0;
        page-break-inside: avoid;
        break-inside: avoid;
        transform: scale(0.92);
        transform-origin: top left;
      }
    `,
  });

  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
  });

  await browser.close();
  console.log(`PDF generated: ${outputPath}`);
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add package.json script**

Modify `package.json` to add:

```json
"generate:ocr-labels-pdf": "node scripts/generate-ocr-labels-pdf.mjs"
```

- [ ] **Step 3: Run the script**

Run: `pnpm generate:ocr-labels-pdf`
Expected: `PDF generated: D:\work\docpal\warehouse-pda\public\ocr-labels.pdf`

- [ ] **Step 4: Verify the PDF exists and looks correct**

Open `public/ocr-labels.pdf` in a PDF viewer and confirm:
- A4 portrait.
- Only scan-step labels (no instructions).
- Barcodes and QR codes visible.
- 2–3 labels per page.

- [ ] **Step 5: Commit script, package.json change, and generated PDF**

```bash
git add scripts/generate-ocr-labels-pdf.mjs package.json public/ocr-labels.pdf
git commit -m "feat: add ocr-labels.pdf generation script and generated pdf"
```

---

### Task 3: Verify regeneration path

**Files:**
- None (verification only)

- [ ] **Step 1: Delete the PDF and regenerate**

```bash
rm public/ocr-labels.pdf
pnpm generate:ocr-labels-pdf
```

- [ ] **Step 2: Confirm file is recreated**

Run: `ls -lh public/ocr-labels.pdf`
Expected: File exists with non-zero size.

---

## Self-review

**Spec coverage:**
- A4 portrait PDF: covered by `page.pdf({ format: 'A4' })` and `@page` CSS.
- Only scan-step labels: covered by hiding `.no-print`, `.step__header`, `.step__body`.
- 2–3 labels per page: covered by scaling labels and stacking with page-break avoidance.
- Barcodes/QR codes: covered by waiting for them before printing.
- Reproducible: covered by committed script.

**Placeholder scan:** No TBD/TODO placeholders.

**Type consistency:** N/A — standalone script.
