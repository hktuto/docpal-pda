import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import QRCode from 'qrcode';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const htmlPath = join(repoRoot, 'public', 'ocr-labels.html');
const outputPath = join(repoRoot, 'public', 'ocr-labels.pdf');

async function generate() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });

  // The page registers a DOMContentLoaded listener, but that event has already
  // fired by the time Playwright evaluates the inline script. Generate barcodes
  // explicitly instead of waiting for the page's own handler.
  await page.waitForFunction(() => typeof JsBarcode === 'function', undefined, { timeout: 30000 });

  // Pre-generate QR code SVGs in Node because the QRCode CDN may not load in headless mode.
  const encStrings = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.label--koa')).map((label) => {
      const encEl = label.querySelector('.label__koa-enc');
      return encEl ? encEl.textContent.trim() : '';
    })
  );
  const qrSvgs = await Promise.all(
    encStrings.map((value) =>
      value
        ? QRCode.toString(value, { type: 'svg', width: 64, margin: 0, errorCorrectionLevel: 'M' })
        : Promise.resolve('')
    )
  );

  await page.evaluate((svgs) => {
    // Generate barcodes.
    document.querySelectorAll('.label__koa-field').forEach((field) => {
      const valueEl = field.querySelector('.label__koa-value');
      const barcodeEl = field.querySelector('.barcode');
      if (valueEl && barcodeEl) {
        const value = valueEl.textContent.trim();
        try {
          JsBarcode(barcodeEl, value, {
            format: 'CODE128',
            width: 1.5,
            height: 28,
            displayValue: false,
            margin: 0,
            background: 'transparent',
          });
        } catch {
          barcodeEl.textContent = '';
        }
      }
    });

    // Inject pre-generated QR code SVGs.
    document.querySelectorAll('.label--koa').forEach((label, index) => {
      const qrEl = label.querySelector('.qr-placeholder');
      const svg = svgs[index];
      if (qrEl && svg) {
        qrEl.innerHTML = svg;
        const svgEl = qrEl.querySelector('svg');
        if (svgEl) {
          svgEl.setAttribute('width', '64');
          svgEl.setAttribute('height', '64');
        }
      }
    });
  }, qrSvgs);

  // Wait briefly for all barcodes and QR codes to be rendered.
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.barcode rect').length > 0 &&
      document.querySelectorAll('.qr-placeholder svg').length > 0,
    undefined,
    { timeout: 30000 }
  );

  // Inject print-optimized CSS for A4, 2-3 labels per page.
  await page.addStyleTag({
    content: `
      @page { size: A4 portrait; margin: 10mm; }
      body { background: #fff; padding: 0; }
      .no-print, .step__header, .step__body { display: none !important; }
      .container { max-width: none; display: flex; flex-direction: column; gap: 6mm; }
      .step { display: contents; }
      .step__labels { display: contents; }
      .label {
        width: 100%;
        min-height: 0;
        padding: 0.4rem;
        gap: 0.15rem;
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .label__qty { font-size: 1.3rem; }
      .label__koa-order { font-size: 0.8rem; }
      .label__koa-po { font-size: 0.6rem; margin-bottom: 0.05rem; }
      .label__koa-label { font-size: 0.65rem; }
      .label__koa-value { font-size: 0.95rem; }
      .label__koa-row { gap: 0.4rem; }
      .label__koa-markings { font-size: 0.75rem; padding: 0.15rem 0; margin: 0.05rem 0; }
      .label__koa-bottom { gap: 0.4rem; margin-top: 0.05rem; }
      .label__koa-enc { font-size: 0.5rem; }
      .label__koa-footer { font-size: 0.65rem; }
      .barcode { height: 16px; }
      .qr-placeholder { width: 40px; height: 40px; }
      .label__koa-rohs { font-size: 0.75rem; top: 0.25rem; right: 0.25rem; }
      .label__use { font-size: 0.55rem; top: 0.25rem; right: 0.25rem; }
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
