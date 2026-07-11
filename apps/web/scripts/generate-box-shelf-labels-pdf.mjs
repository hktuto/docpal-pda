import { chromium } from 'playwright';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outputPath = join(repoRoot, 'public', 'box-shelf-labels.pdf');

const boxIds = Array.from({ length: 15 }, (_, i) =>
  `BOX-HK1-2826-${String(i + 1).padStart(6, '0')}`
);

const shelfCodes = [
  'A-01-01',
  'A-01-02',
  'A-01-03',
  'A-01-04',
  'A-01-05',
  'A-01-06',
  'A-01-07',
  'A-01-08',
  'B-01-01',
  'B-02-01',
];

const items = [
  ...boxIds.map((code) => ({ type: 'BOX ID', code })),
  ...shelfCodes.map((code) => ({ type: 'SHELF CODE', code })),
];

const qrSvgs = await Promise.all(
  items.map((item) =>
    QRCode.toString(item.code, {
      type: 'svg',
      width: 200,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
  )
);

const labelHtml = (item, svg) => `
  <div class="label">
    <div class="label-type">${item.type}</div>
    <div class="qr">${svg}</div>
    <div class="label-code">${item.code}</div>
  </div>
`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Box &amp; Shelf QR Labels</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      background: #fff;
    }
    @page { size: A4 portrait; margin: 8mm; }
    .sheet {
      width: 100%;
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 4mm;
      padding: 4mm;
    }
    .label {
      border: 1px solid #111;
      padding: 3mm;
      height: 50mm;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      page-break-inside: avoid;
      break-inside: avoid;
      text-align: center;
    }
    .label-type {
      font-size: 8pt;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .qr {
      width: 28mm;
      height: 28mm;
    }
    .qr svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .label-code {
      font-size: 10pt;
      font-weight: bold;
      word-break: break-all;
      line-height: 1.2;
    }
  </style>
</head>
<body>
  <div class="sheet">
    ${items.map((item, i) => labelHtml(item, qrSvgs[i])).join('')}
  </div>
</body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle' });
await page.pdf({
  path: outputPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' },
});
await browser.close();

console.log(`PDF generated: ${outputPath}`);
