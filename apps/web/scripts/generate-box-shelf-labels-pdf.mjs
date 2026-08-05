import { chromium } from 'playwright';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outputPath = join(repoRoot, 'public', 'box-shelf-labels.pdf');

// The 10 pre-generated empty put-away boxes from the demo seed
// (new_seed/demo-scenario.xlsx → shelf_boxes). Each label carries the box id
// (scanned during put-away) and the shelf the box belongs to.
const items = [
  { boxId: 'BOX-H-20260701-0005', shelfCode: 'A-03-01' },
  { boxId: 'BOX-H-20260701-0006', shelfCode: 'A-03-02' },
  { boxId: 'BOX-H-20260701-0007', shelfCode: 'A-03-03' },
  { boxId: 'BOX-H-20260701-0008', shelfCode: 'A-03-04' },
  { boxId: 'BOX-H-20260701-0009', shelfCode: 'A-03-05' },
  { boxId: 'BOX-H-20260701-0010', shelfCode: 'A-04-01' },
  { boxId: 'BOX-H-20260701-0011', shelfCode: 'A-04-02' },
  { boxId: 'BOX-H-20260701-0012', shelfCode: 'A-04-03' },
  { boxId: 'BOX-H-20260701-0013', shelfCode: 'A-04-04' },
  { boxId: 'BOX-H-20260701-0014', shelfCode: 'A-04-05' },
];

const qrSvgs = await Promise.all(
  items.map((item) =>
    QRCode.toString(item.boxId, {
      type: 'svg',
      width: 200,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
  )
);

const labelHtml = (item, svg) => `
  <div class="label">
    <div class="label-type">Shelf box</div>
    <div class="qr">${svg}</div>
    <div class="label-code">${item.boxId}</div>
    <div class="label-shelf">Shelf ${item.shelfCode}</div>
  </div>
`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Shelf Box QR Labels</title>
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
      grid-template-columns: repeat(2, 1fr);
      gap: 4mm;
      padding: 4mm;
    }
    .label {
      border: 1px solid #111;
      padding: 3mm;
      height: 60mm;
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
      width: 32mm;
      height: 32mm;
    }
    .qr svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .label-code {
      font-size: 12pt;
      font-weight: bold;
      word-break: break-all;
      line-height: 1.2;
    }
    .label-shelf {
      font-size: 9pt;
      color: #444;
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

console.log(`PDF generated: ${outputPath} (${items.length} labels)`);
