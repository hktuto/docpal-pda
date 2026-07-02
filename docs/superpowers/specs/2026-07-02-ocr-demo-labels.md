# OCR Demo Labels

## Purpose

`public/ocr-labels.html` is a standalone, on-screen label sheet used to test the Camera OCR demo. Instead of printing labels, you display this page on a monitor or another device and point the Android camera at each label.

## How to use

1. Make sure the dev server or generated build is running and the Android app can reach it.
2. Open the label page in a desktop browser:

   ```text
   http://<dev-server-ip>:3000/ocr-labels.html
   ```

3. In the Android app, open the **Camera OCR Demo** page.
4. Tap **Take photo** and point the camera at one of the labels on screen.
5. Verify that the captured text matches the label.

## Layout

The page is organized into two sections:

1. **Receiving Labels** — labels that match items in seeded receiving orders.
2. **Picking Labels** — labels that match items in seeded picking orders.

Each subsection corresponds to a specific order, e.g. `RO-240701-001` or `TN-240701-005`.

## Label design

- **Carton-style background** with a crosshatch texture.
- **Square-cornered white labels** with a thick black border and a hard shadow, so they look like stickers on cardboard.
- **High-contrast monospace text** sized for on-device ML Kit OCR.
- A small **Target** pill at the top of each label showing the real seeded quantity.
- A large **demo quantity** below it, intentionally smaller than the target so the same label can be scanned multiple times during a demo.

## Demo quantities vs. seeded quantities

The displayed demo quantity is a fraction of the seeded target quantity. For example:

| Order | Part | Seeded target | Demo label qty |
|---|---|---|---|
| RO-240701-001 | RES-0603-10K | 40000 | 5000 |
| RO-240701-001 | CAP-0805-100N | 5000 | 1000 |
| RO-240701-002 | IC-LM358DR | 1000 | 200 |
| TN-240701-002 | RES-0603-10K | 20000 | 2000 |
| TN-240701-005 | MOS-IRLML6244 | 200 | 50 |

This lets you scan the same label repeatedly and pretend each scan represents a partial pick or put-away without running out of stock.

## Matching data

The labels are derived directly from `db/seed.ts`. If the seed data changes, update the values in `public/ocr-labels.html` to keep them in sync.

## Notes

- The page is static HTML/CSS only; no JavaScript is required.
- It lives in `public/` so Nuxt serves it as a plain file.
- The print styles are kept in place, but the page is optimized for on-screen scanning.
