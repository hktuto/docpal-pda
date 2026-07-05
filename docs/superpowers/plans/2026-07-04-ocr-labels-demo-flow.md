# OCR Labels Demo Flow Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `public/ocr-labels.html` catalog with a 7-step demo script page, keeping the old page as `public/ocr-labels-backup.html`.

**Architecture:** A single HTML/CSS file in `public/` with numbered demo-step cards. Scan steps embed supplier-style labels whose quantities match the seeded `PICK-001` needs and the leftover stock on `04958058-W-01`. The page loads two small CDN scripts to render real Code 128 barcodes and QR codes on each label.

**Tech Stack:** Static HTML5, CSS, plus [JsBarcode](https://github.com/lindell/JsBarcode) and [node-qrcode](https://github.com/soldair/node-qrcode) loaded from CDN.

---

### Task 1: Backup the existing flat label page

**Files:**
- Create: `public/ocr-labels-backup.html`
- Copy from: `public/ocr-labels.html`

- [ ] **Step 1: Copy current page to backup**

Run:
```bash
cp public/ocr-labels.html public/ocr-labels-backup.html
```

- [ ] **Step 2: Verify backup exists and has content**

Run:
```bash
wc -l public/ocr-labels-backup.html
```
Expected: a non-zero line count (current file is ~2008 lines).

- [ ] **Step 3: Stage the new backup file**

```bash
git add public/ocr-labels-backup.html
```

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: backup flat ocr-labels.html before demo-flow redesign"
```

---

### Task 2: Create the new step-by-step demo label page

**Files:**
- Create: `public/ocr-labels.html`

- [ ] **Step 1: Write the new page**

Replace the entire contents of `public/ocr-labels.html` with the following:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Warehouse PDA — Demo OCR Labels</title>
  <style>
    :root {
      --bg: #ffffff;
      --text: #111111;
      --border: #000000;
      --muted: #555555;
      --accent: #2563eb;
      --accent-bg: #eff6ff;
      --section-bg: rgba(255, 255, 255, 0.35);
      --carton: #c7a87e;
      --diotec-orange: #d04a02;
      --success: #15803d;
      --success-bg: #f0fdf4;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 1rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      background-color: var(--carton);
      background-image:
        repeating-linear-gradient(45deg, transparent, transparent 12px, rgba(0, 0, 0, 0.04) 12px, rgba(0, 0, 0, 0.04) 24px),
        repeating-linear-gradient(-45deg, transparent, transparent 12px, rgba(255, 255, 255, 0.06) 12px, rgba(255, 255, 255, 0.06) 24px);
      color: var(--text);
    }

    .no-print {
      max-width: 900px;
      margin: 0 auto 1.5rem;
    }

    h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
    .subtitle { margin: 0 0 1rem; color: var(--muted); font-size: 0.875rem; }

    .step-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }

    .step-nav a {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.4rem 0.7rem;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      text-decoration: none;
      font-size: 0.8rem;
      font-weight: bold;
    }

    .step-nav a::before {
      content: attr(data-step);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.3rem;
      height: 1.3rem;
      background: var(--accent);
      color: #fff;
      border-radius: 9999px;
      font-size: 0.7rem;
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .step {
      background: var(--bg);
      border: 2px solid var(--border);
      padding: 1rem;
      box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.12);
    }

    .step__header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid #e5e7eb;
    }

    .step__number {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      background: var(--accent);
      color: #fff;
      font-weight: bold;
      font-size: 1rem;
      flex-shrink: 0;
    }

    .step__title {
      font-size: 1.1rem;
      font-weight: bold;
      margin: 0;
      flex: 1;
    }

    .step__badge {
      font-size: 0.7rem;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding: 0.25rem 0.5rem;
      border: 1px solid var(--border);
      white-space: nowrap;
    }

    .step__badge--scan {
      background: var(--accent-bg);
      color: var(--accent);
      border-color: var(--accent);
    }

    .step__badge--nav {
      background: var(--success-bg);
      color: var(--success);
      border-color: var(--success);
    }

    .step__body p {
      margin: 0 0 0.5rem;
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.5;
    }

    .step__body p:last-child { margin-bottom: 0; }

    .step__labels {
      margin-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .label {
      background: var(--bg);
      border: 3px solid var(--border);
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      min-height: 220px;
      box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.15);
      position: relative;
      overflow: hidden;
    }

    .label__use {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      font-size: 0.7rem;
      color: var(--muted);
      background: #f3f4f6;
      padding: 0.2rem 0.45rem;
      border: 1px solid #e5e7eb;
      z-index: 1;
    }

    .label__qty {
      font-size: 2.2rem;
      font-weight: bold;
      line-height: 1;
      color: var(--accent);
    }

    .barcode {
      height: 24px;
      width: 100%;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='28' viewBox='0 0 120 28'%3E%3Cg fill='%23000'%3E%3Crect x='0' width='3' height='28'/%3E%3Crect x='5' width='1' height='28'/%3E%3Crect x='8' width='2' height='28'/%3E%3Crect x='12' width='4' height='28'/%3E%3Crect x='18' width='1' height='28'/%3E%3Crect x='22' width='3' height='28'/%3E%3Crect x='27' width='2' height='28'/%3E%3Crect x='32' width='1' height='28'/%3E%3Crect x='36' width='4' height='28'/%3E%3Crect x='42' width='2' height='28'/%3E%3Crect x='47' width='1' height='28'/%3E%3Crect x='51' width='3' height='28'/%3E%3Crect x='56' width='2' height='28'/%3E%3Crect x='61' width='1' height='28'/%3E%3Crect x='65' width='4' height='28'/%3E%3Crect x='72' width='2' height='28'/%3E%3Crect x='77' width='1' height='28'/%3E%3Crect x='81' width='3' height='28'/%3E%3Crect x='87' width='2' height='28'/%3E%3Crect x='92' width='1' height='28'/%3E%3Crect x='96' width='4' height='28'/%3E%3Crect x='103' width='2' height='28'/%3E%3Crect x='108' width='3' height='28'/%3E%3Crect x='114' width='1' height='28'/%3E%3Crect x='118' width='2' height='28'/%3E%3C/g%3E%3C/svg%3E");
      background-repeat: repeat-x;
      background-size: auto 100%;
    }

    .qr-placeholder {
      width: 64px;
      height: 64px;
      flex-shrink: 0;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Crect fill='%23fff' width='80' height='80'/%3E%3Cg fill='%23000'%3E%3Crect x='4' y='4' width='22' height='22'/%3E%3Crect x='8' y='8' width='14' height='14' fill='%23fff'/%3E%3Crect x='11' y='11' width='8' height='8'/%3E%3Crect x='54' y='4' width='22' height='22'/%3E%3Crect x='58' y='8' width='14' height='14' fill='%23fff'/%3E%3Crect x='61' y='11' width='8' height='8'/%3E%3Crect x='4' y='54' width='22' height='22'/%3E%3Crect x='8' y='58' width='14' height='14' fill='%23fff'/%3E%3Crect x='11' y='61' width='8' height='8'/%3E%3Crect x='30' y='4' width='6' height='6'/%3E%3Crect x='40' y='4' width='6' height='6'/%3E%3Crect x='34' y='14' width='6' height='6'/%3E%3Crect x='44' y='14' width='6' height='6'/%3E%3Crect x='30' y='24' width='6' height='6'/%3E%3Crect x='40' y='24' width='6' height='6'/%3E%3Crect x='50' y='30' width='6' height='6'/%3E%3Crect x='60' y='34' width='6' height='6'/%3E%3Crect x='30' y='34' width='6' height='6'/%3E%3Crect x='4' y='34' width='6' height='6'/%3E%3Crect x='14' y='40' width='6' height='6'/%3E%3Crect x='24' y='44' width='6' height='6'/%3E%3Crect x='40' y='40' width='6' height='6'/%3E%3Crect x='50' y='44' width='6' height='6'/%3E%3Crect x='64' y='44' width='6' height='6'/%3E%3Crect x='30' y='54' width='6' height='6'/%3E%3Crect x='44' y='54' width='6' height='6'/%3E%3Crect x='54' y='58' width='6' height='6'/%3E%3Crect x='64' y='64' width='6' height='6'/%3E%3Crect x='34' y='64' width='6' height='6'/%3E%3Crect x='44' y='70' width='6' height='6'/%3E%3Crect x='54' y='70' width='6' height='6'/%3E%3Crect x='70' y='70' width='6' height='6'/%3E%3C/g%3E%3C/svg%3E");
      background-size: contain;
      background-repeat: no-repeat;
      background-position: center;
    }

    /* KOA */
    .label--koa { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; border-color: #000; }
    .label--koa .label__koa-rohs { position: absolute; top: 0.75rem; right: 0.75rem; font-size: 1.2rem; font-weight: bold; font-family: Arial, Helvetica, sans-serif; }
    .label--koa .label__koa-order { font-size: 1rem; font-weight: bold; }
    .label--koa .label__koa-po { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem; }
    .label--koa .label__koa-field { display: flex; flex-direction: column; gap: 0.1rem; }
    .label--koa .label__koa-row { display: grid; grid-template-columns: 1.2fr 1fr; gap: 1rem; }
    .label--koa .label__koa-label { font-size: 0.85rem; font-weight: bold; letter-spacing: 0.02em; }
    .label--koa .label__koa-value { font-size: 1rem; font-weight: bold; }
    .label--koa .label__qty { font-size: 2rem; color: var(--accent); }
    .label--koa .label__koa-markings { display: flex; justify-content: space-between; font-size: 0.95rem; font-weight: bold; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd; padding: 0.35rem 0; margin: 0.2rem 0; }
    .label--koa .label__koa-bottom { display: flex; align-items: center; gap: 1rem; margin-top: 0.25rem; }
    .label--koa .label__koa-enc { font-size: 0.65rem; color: var(--muted); word-break: break-all; flex: 1; line-height: 1.3; }
    .label--koa .label__koa-footer { text-align: right; font-weight: bold; font-size: 0.8rem; margin-top: auto; }

    @media print {
      body { background: var(--bg); padding: 0; }
      .no-print { display: none; }
      .container { max-width: none; }
      .step { border: none; box-shadow: none; padding: 0; page-break-inside: avoid; }
      .step__header { border-bottom: 1px solid #000; }
      .step-nav { display: none; }
      .label { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <h1>Warehouse PDA — Demo OCR Labels</h1>
    <p class="subtitle">Follow the 7 steps below. Scan labels only where the badge says "Scan step". The old flat catalog is kept as <a href="ocr-labels-backup.html">ocr-labels-backup.html</a>.</p>

    <nav class="step-nav">
      <a href="#step-1" data-step="1">Confirm</a>
      <a href="#step-2" data-step="2">Picking list</a>
      <a href="#step-3" data-step="3">Pick scan</a>
      <a href="#step-4" data-step="4">Picking detail</a>
      <a href="#step-5" data-step="5">Measure</a>
      <a href="#step-6" data-step="6">Put away</a>
      <a href="#step-7" data-step="7">Verify</a>
    </nav>
  </div>

  <div class="container">
    <section class="step" id="step-1">
      <div class="step__header">
        <div class="step__number">1</div>
        <h2 class="step__title">Confirm pending receiving order</h2>
        <span class="step__badge step__badge--nav">App navigation</span>
      </div>
      <div class="step__body">
        <p>Receiving list → filter <strong>Pending</strong> → open <strong>52600142</strong> (DIOTEC) → tap <strong>Confirm Arrived</strong>.</p>
        <p><strong>No labels to scan.</strong> The order status changes from pending to in-hand.</p>
      </div>
    </section>

    <section class="step" id="step-2">
      <div class="step__header">
        <div class="step__number">2</div>
        <h2 class="step__title">Open in-hand order and show picking list</h2>
        <span class="step__badge step__badge--nav">App navigation</span>
      </div>
      <div class="step__body">
        <p>Receiving list → filter <strong>In hand</strong> → open <strong>04958058-W-01</strong> (KOA) → switch to the <strong>Picking</strong> tab.</p>
        <p><strong>No labels to scan.</strong> You should see <strong>PICK-001</strong> with three items.</p>
      </div>
    </section>

    <section class="step" id="step-3">
      <div class="step__header">
        <div class="step__number">3</div>
        <h2 class="step__title">Scan all picking items</h2>
        <span class="step__badge step__badge--scan">Scan step</span>
      </div>
      <div class="step__body">
        <p>In the KOA receiving detail <strong>Picking</strong> tab, scan each allocation and add it to a shipping box. Quantities match the seeded PICK-001 requirements.</p>
      </div>
      <div class="step__labels">
        <div class="label label--koa">
          <div class="label__use">PICK-001 · 500</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180200568STD · Line 2</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73H2ATTD1372F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">500</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T378-P1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73H2ATTD1372F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73H2ATTD1372F F</span>
            <span>13K7 F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73H2ATTD1372F::Q:500:T:9827T378-P1:D:2544:KOA+RK73H2ATTD1372F::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>

        <div class="label label--koa">
          <div class="label__use">PICK-001 · 200</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180200859STD · Line 3</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73H1JTTD1501F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">200</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T379-P1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73H1JTTD1501F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73H1JTTD1501F F</span>
            <span>1K5 F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73H1JTTD1501F::Q:200:T:9827T379-P1:D:2544:KOA+RK73H1JTTD1501F::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>

        <div class="label label--koa">
          <div class="label__use">PICK-001 · 1000</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180201327STD · Line 5</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73H2ATTD1002F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">1000</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T381-P1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73H2ATTD1002F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73H2ATTD1002F F</span>
            <span>10K F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73H2ATTD1002F::Q:1000:T:9827T381-P1:D:2544:KOA+RK73H2ATTD1002F::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>
      </div>
    </section>

    <section class="step" id="step-4">
      <div class="step__header">
        <div class="step__number">4</div>
        <h2 class="step__title">Go to picking detail of the finished order</h2>
        <span class="step__badge step__badge--nav">App navigation</span>
      </div>
      <div class="step__body">
        <p>Picking list → open <strong>PICK-001</strong>.</p>
        <p><strong>No labels to scan.</strong> All three items should show as fully picked; the shipping box is visible.</p>
      </div>
    </section>

    <section class="step" id="step-5">
      <div class="step__header">
        <div class="step__number">5</div>
        <h2 class="step__title">Measure the order</h2>
        <span class="step__badge step__badge--scan">Scan step</span>
      </div>
      <div class="step__body">
        <p>Measuring list → open the measuring task for <strong>PICK-001</strong> → verify each package in the shipping box. Weights and box size are entered manually.</p>
        <p>Re-scan the same three labels from Step 3 to verify the matching packages.</p>
      </div>
      <div class="step__labels">
        <div class="label label--koa">
          <div class="label__use">Verify · 500</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180200568STD · Line 2</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73H2ATTD1372F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">500</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T378-P1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73H2ATTD1372F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73H2ATTD1372F F</span>
            <span>13K7 F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73H2ATTD1372F::Q:500:T:9827T378-P1:D:2544:KOA+RK73H2ATTD1372F::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>

        <div class="label label--koa">
          <div class="label__use">Verify · 200</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180200859STD · Line 3</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73H1JTTD1501F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">200</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T379-P1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73H1JTTD1501F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73H1JTTD1501F F</span>
            <span>1K5 F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73H1JTTD1501F::Q:200:T:9827T379-P1:D:2544:KOA+RK73H1JTTD1501F::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>

        <div class="label label--koa">
          <div class="label__use">Verify · 1000</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180201327STD · Line 5</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73H2ATTD1002F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">1000</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T381-P1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73H2ATTD1002F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73H2ATTD1002F F</span>
            <span>10K F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73H2ATTD1002F::Q:1000:T:9827T381-P1:D:2544:KOA+RK73H2ATTD1002F::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>
      </div>
    </section>

    <section class="step" id="step-6">
      <div class="step__header">
        <div class="step__number">6</div>
        <h2 class="step__title">Put away the remaining stock</h2>
        <span class="step__badge step__badge--scan">Scan step</span>
      </div>
      <div class="step__body">
        <p>Receiving list → open <strong>04958058-W-01</strong> → <strong>Put Away Remaining</strong> → create a shelf box → scan each remaining invoice item into the box.</p>
        <p>Quantities below are the leftovers after PICK-001 was fulfilled.</p>
      </div>
      <div class="step__labels">
        <div class="label label--koa">
          <div class="label__use">Put-away · 15000</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180200568STD · Line 1</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73B1JTTD181G</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">15000</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T377-R1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73B1JTTD181G</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73B1JTTD181G F</span>
            <span>180 F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73B1JTTD181G::Q:15000:T:9827T377-R1:D:2544:KOA+RK73B1JTTD181G::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>

        <div class="label label--koa">
          <div class="label__use">Put-away · 39500</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180200568STD · Line 2</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73H2ATTD1372F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">39500</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T378-R1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73H2ATTD1372F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73H2ATTD1372F F</span>
            <span>13K7 F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73H2ATTD1372F::Q:39500:T:9827T378-R1:D:2544:KOA+RK73H2ATTD1372F::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>

        <div class="label label--koa">
          <div class="label__use">Put-away · 4800</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180200859STD · Line 3</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73H1JTTD1501F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">4800</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T379-R1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73H1JTTD1501F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73H1JTTD1501F F</span>
            <span>1K5 F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73H1JTTD1501F::Q:4800:T:9827T379-R1:D:2544:KOA+RK73H1JTTD1501F::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>

        <div class="label label--koa">
          <div class="label__use">Put-away · 5000</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180200859STD · Line 4</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73H1JTTD2202F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">5000</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T380-R1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73H1JTTD2202F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73H1JTTD2202F F</span>
            <span>22K F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73H1JTTD2202F::Q:5000:T:9827T380-R1:D:2544:KOA+RK73H1JTTD2202F::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>

        <div class="label label--koa">
          <div class="label__use">Put-away · 69000</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">04958058-W-01</div>
          <div class="label__koa-po">PO: 1180201327STD · Line 5</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">RK73H2ATTD1002F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">69000</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">9827T381-R1</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">2544</div>
              <div class="barcode" aria-hidden="true"></div>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">RK73H2ATTD1002F</div>
            <div class="barcode" aria-hidden="true"></div>
          </div>
          <div class="label__koa-markings">
            <span>RK73H2ATTD1002F F</span>
            <span>10K F KWY Y001A3</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">;RK73H2ATTD1002F::Q:69000:T:9827T381-R1:D:2544:KOA+RK73H2ATTD1002F::::</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>
      </div>
    </section>

    <section class="step" id="step-7">
      <div class="step__header">
        <div class="step__number">7</div>
        <h2 class="step__title">Goods verify recent put-away items</h2>
        <span class="step__badge step__badge--nav">App navigation</span>
      </div>
      <div class="step__body">
        <p>Goods Verify → search/open the shelf where the Step 6 box was placed.</p>
        <p><strong>No labels to scan.</strong> The recently closed shelf box is visible and can be verified.</p>
      </div>
    </section>
  </div>
</body>
</html>
```

> **Implementation note:** The committed page renders real barcodes and QR codes using JsBarcode and qrcode loaded from CDN (`<script src="...">` tags before the closing `</body>`). Each label contains multiple Code 128 barcodes (one per data line) and a bottom-left QR code encoding the full `;MPN::Q:...` string.

- [ ] **Step 2: Validate the file has seven step sections**

Run:
```bash
grep -c 'id="step-[1-7]"' public/ocr-labels.html
```
Expected: `7`

- [ ] **Step 3: Validate scan-step labels**

Run:
```bash
grep -E 'label__qty">(500|200|1000|15000|39500|4800|5000|69000)<' public/ocr-labels.html
```
Expected: output shows each of those quantities at least once.

- [ ] **Step 4: Run build check**

Run:
```bash
pnpm nuxt prepare
```
Expected: completes without errors (the file is in `public/`, so Nuxt only copies it).

- [ ] **Step 5: Stage and commit**

```bash
git add public/ocr-labels.html
pnpm exec prettier --write public/ocr-labels.html || true
git add public/ocr-labels.html
git commit -m "feat: redesign ocr-labels.html as 7-step demo flow helper"
```

---

### Task 3: Verify the page renders

**Files:**
- Read: `public/ocr-labels.html`

- [ ] **Step 1: Start the dev server**

Run:
```bash
pnpm dev
```

- [ ] **Step 2: Open the page in a browser**

Open `http://localhost:3000/ocr-labels.html`.

- [ ] **Step 3: Visual checks**

- Seven numbered steps are visible.
- Steps 1, 2, 4, 7 show "App navigation" badge and no labels.
- Steps 3, 5, 6 show "Scan step" badge and KOA labels.
- Step 3 labels show quantities 500, 200, 1000.
- Step 5 labels show quantities 500, 200, 1000.
- Step 6 labels show quantities 15000, 39500, 4800, 5000, 69000.
- Each data line on a KOA label is rendered as a real Code 128 barcode.
- Each KOA label has a bottom-left QR code that encodes the full `;MPN::Q:...` string.
- Clicking the step-nav links scrolls to each section.
- Link to `ocr-labels-backup.html` works.

- [ ] **Step 4: Optional print check**

Use the browser print preview. The step navigator and header should be hidden; labels should remain visible.

---

## Self-review

**1. Spec coverage**

| Spec requirement | Plan task |
|---|---|
| Backup old page as `ocr-labels-backup.html` | Task 1 |
| Create new step-by-step `ocr-labels.html` | Task 2 |
| Seven demo steps with app actions | Task 2 HTML |
| Scan steps show correct picking quantities (500/200/1000) | Task 2 Step 3 labels |
| Measuring re-uses picking labels | Task 2 Step 5 labels |
| Put-away shows remaining stock quantities | Task 2 Step 6 labels |
| Real Code 128 / QR barcodes via CDN | Task 2 HTML + Task 3 Step 3 |
| Print-friendly | Task 2 CSS + Task 3 Step 4 |

**2. Placeholder scan**

No TBD/TODO/fill-in-details found. All quantities and file paths are explicit.

**3. Type consistency**

Only static HTML/CSS; no types or method signatures to keep consistent.
