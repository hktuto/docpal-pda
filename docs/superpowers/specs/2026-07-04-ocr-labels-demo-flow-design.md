# OCR Labels — Demo Flow Helper

## Purpose

Replace the flat `public/ocr-labels.html` catalog with a step-by-step demo script so a presenter can follow the 7-stage warehouse PDA demo without hunting for the right label. The old page is kept as a backup.

## Files

- `public/ocr-labels.html` — new step-by-step demo label sheet (this spec).
- `public/ocr-labels-backup.html` — backup of the previous flat catalog.

## Design principles

- One scrolling page, seven clearly numbered sections.
- Each section states what to do in the app and, when relevant, shows the exact labels to scan.
- Labels use the same supplier visual styles as the backup page (KOA, ABLIC, DIOTEC) so ML Kit OCR continues to recognize them.
- Quantities on scan labels match the exact values the current demo flow needs:
  - Picking labels match `picking_items.qty` for `PICK-001`.
  - Put-away labels match the remaining stock on `04958058-W-01` after `PICK-001` is fulfilled.
- Non-scan sections are marked "App navigation" so the presenter knows no label is needed.

## Demo flow sections

### Step 1 — Confirm pending receiving order

- **App action:** Receiving list → filter `pending` → open `52600142` (DIOTEC) → tap **Confirm Arrived**.
- **Scan?** No.
- **Expected result:** Order status changes from `pending` to `in_hand`.

### Step 2 — Open in-hand order and view related picking list

- **App action:** Receiving list → filter `in_hand` → open `04958058-W-01` (KOA) → switch to the **Picking** tab.
- **Scan?** No.
- **Expected result:** `PICK-001` is listed with three items:
  - `RK73H2ATTD1372F` — 500
  - `RK73H1JTTD1501F` — 200
  - `RK73H2ATTD1002F` — 1000

### Step 3 — Scan all picking items

- **App action:** In the KOA receiving detail `Picking` tab, scan each allocation and add it to a shipping box.
- **Scan?** Yes — three KOA-style labels:
  - `RK73H2ATTD1372F` — qty **500**
  - `RK73H1JTTD1501F` — qty **200**
  - `RK73H2ATTD1002F` — qty **1000**
- **Note:** After all three scans, create a shipping box and add the scanned packages to finish the picking order.

### Step 4 — Go to picking detail of the finished order

- **App action:** Picking list → open `PICK-001`.
- **Scan?** No.
- **Expected result:** All three items show as fully picked; the shipping box is visible.

### Step 5 — Measure the order

- **App action:** Measuring list → open the measuring task for `PICK-001` → verify each package in the shipping box.
- **Scan?** Yes — re-use the same three labels from Step 3 (`500`, `200`, `1000`) to verify the matching packages.
- **Note:** Weights and box size are entered manually.

### Step 6 — Put away the remaining stock of the receiving order

- **App action:** Receiving list → `04958058-W-01` → **Put Away Remaining** → create a shelf box → scan each remaining invoice item into the box.
- **Scan?** Yes — five KOA-style labels with the exact remaining quantities after `PICK-001`:
  - `RK73B1JTTD181G` — **15000**
  - `RK73H2ATTD1372F` — **39500** (40000 − 500)
  - `RK73H1JTTD1501F` — **4800** (5000 − 200)
  - `RK73H1JTTD2202F` — **5000**
  - `RK73H2ATTD1002F` — **69000** (70000 − 1000)

### Step 7 — Goods verify recent put-away items

- **App action:** Goods Verify → search/open the shelf where the Step 6 box was placed.
- **Scan?** No.
- **Expected result:** The recently closed shelf box is visible and can be verified.

## Visual layout

- Top header: page title and a link to `ocr-labels-backup.html`.
- A compact step navigator (anchors) linking to each of the seven sections.
- Each section card contains:
  - Step number and title.
  - Badge: `Scan step` (accent color) or `App navigation` (muted).
  - One or two sentences describing the app action.
  - Label grid, only present for scan steps.
- Label rendering reuses the existing CSS classes/styles from the backup page (`label--koa`, `label--ablic`, etc.) so the page stays maintainable and OCR-friendly.
- Print styles hide the header and navigator; labels keep `page-break-inside: avoid`.

## Data source

All quantities are derived from `db/seed.ts`:

- `PICK-001` picking items are seeded at 500 / 200 / 1000.
- `04958058-W-01` receiving items are seeded at 15000 / 40000 / 5000 / 5000 / 70000.
- If seed data changes, update the quantities in `public/ocr-labels.html` accordingly.

## Notes

- The page is mostly static HTML/CSS, but it loads two small CDN scripts to render real barcodes/QR codes on page load:
  - [JsBarcode](https://github.com/lindell/JsBarcode) for Code 128 linear barcodes.
  - [node-qrcode](https://github.com/soldair/node-qrcode) for the bottom-left QR codes.
- The display device must have internet access so the CDN scripts can load. The Android camera only looks at the screen; it does not load the page.
- The backup file preserves the old flat catalog so ad-hoc scanning of other orders or parts still works.
