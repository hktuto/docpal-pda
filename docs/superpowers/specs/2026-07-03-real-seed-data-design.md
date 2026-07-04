# Real Supplier Seed Data Design

## Objective

Replace the synthetic suppliers, parts, and order data in `db/seed.ts` with real
information extracted from the sample documents under
`docs/Supplier Sample Documents/`, while keeping the demo flows coherent and
usable.

## Scope

- **All 25 supplier folders** are represented in the seed, but the data is
  summarized/curated rather than exhaustively extracted.
- **Receiving flow**: real supplier names, part numbers, invoice/packing-list
  numbers, and quantities.
- **Picking + measuring flows**: a derived set of outbound orders that draw from
  the real receiving stock.
- **Label images** are intentionally not used for seeding; they remain test
  assets for the OCR scanning feature.

## Data volume targets

- **Receiving orders**: 2–3 in total, each for a different selected supplier.
  Each receiving order has **2–5 line items**.
- **Picking orders**: a small number of outbound orders (roughly 3–6 total)
  drawing from receiving stock and pre-existing inventory.
- **Pre-existing shelf inventory**: items for parts from suppliers *not* chosen
  for receiving orders, so put-away and goods-verify still have stock to work
  with.

## Source-to-schema mapping

| Seed entity | Source |
|-------------|--------|
| `suppliers` | One row per `docs/Supplier Sample Documents/<folder>/`. Code derived from folder name (uppercase, first token before a space or hyphen, truncated to 6 chars; disambiguated if duplicate), name preserved as-is. |
| `parts` | Distinct part numbers found in packing lists / invoices. Customer part number → `partNo`; supplier internal code → `internalCode` when present. |
| `receivingOrders` | 2–3 curated documents in total, each from a different supplier selected from the extracted data. `refNo` uses the real document number when readable, otherwise a generated `RO-YYMMDD-NNN`. |
| `receivingInvoices` | One per receiving order, using the document invoice/packing-list number. |
| `receivingInvoiceItems` | Line items from the document. `qty` is the expected quantity. `coo` parsed when available; otherwise a default based on the supplier’s region (e.g., `JP` for Japanese suppliers, `CN` for Chinese, `US` for US-based) or `XX` if unknown. |
| `shelves` | Existing shelf grid expanded slightly (zones A, B, C). |
| `inventoryLots` | Global pre-existing shelf stock for a curated set of parts that do *not* appear in the current receiving orders. Created directly in the seed and located on shelves in zones A/B/C. |
| `pickingOrders` | 3–6 outbound orders in total, referencing real parts and drawing from receiving items + pre-existing inventory. |
| `pickingItems` | 1–4 lines per picking order. |
| `allocations`, `inventoryLotSources` | Created by calling `allocatePickingOrder()` after seeding, exactly as the current seed does. |

## Extraction approach

1. Create a temporary helper script `scripts/extract-seed-data.mjs` (not part of
   the shipped app).
2. The script walks `docs/Supplier Sample Documents/`, skips `Thumbs.db`, lock
   files, and image files, and extracts text/tables from:
   - PDFs via `pdf-parse`
   - `.xlsx` files via `xlsx`
   - `.csv` files via `csv-parse`
3. Output a JSON summary (`scripts/seed-extraction-summary.json`) containing:
   - suppliers
   - parts
   - invoices / packing lists with line items
   - a confidence flag per extracted field
4. Review the JSON manually, fix parsing errors, merge duplicates, and choose
   the curated subset that becomes `db/seed.ts`.
5. Delete or git-ignore the helper script and summary JSON once the seed is
   finalized (they are scaffolding, not product code).

## Seed structure

- `db/seed.ts` remains a single `seedDb(db)` function.
- Hard-coded fake suppliers and parts are replaced with arrays built from the
  real data.
- Receiving order quantities are kept large enough to satisfy derived picking
  quantities so `allocatePickingOrder()` succeeds.
- At least one of the 2–3 receiving orders stays in `pending` status so the
  receiving list still shows actionable work; the rest are `in_hand`.
- Pre-existing shelf inventory is created with `totalQty > 0` and `allocatedQty
  = 0`, located on shelves in zones A/B/C, for parts not present in the current
  receiving orders.

## Error handling for messy data

- Scanned/image-only PDFs that yield no text are skipped; if a sibling
  `.xlsx`/`.csv` exists, its data is used instead.
- Unreadable line-item quantities are replaced with a summarized sensible value
  and noted in the extraction summary.
- Duplicate documents (e.g., separate invoice and packing list for the same
  shipment) are merged into one receiving order with one invoice.
- Suppliers not selected for receiving orders are still seeded with their
  identity and their parts appear in pre-existing shelf inventory lots.

## Verification

1. `pnpm nuxt prepare` passes without TypeScript errors.
2. Clear the browser’s IndexedDB (or use a private window) and reload the app.
3. Log in as `operator` / `DocPal2026!`.
4. Spot-check:
   - Receiving list shows 2–3 orders total, each from a real supplier.
   - Each receiving order has 2–5 line items.
   - Picking list shows 3–6 orders total.
   - Allocation succeeds for in-stock picking orders.
   - Measuring tasks appear for allocated picking orders.
5. Run `./gradlew :app:testDebugUnitTest` from `android/` to confirm native
   tests are unaffected.

## Out of scope

- OCR label-image extraction for seeding (images remain scan-demo assets only).
- Automatic re-seeding on schema changes; users still need to clear IndexedDB.
- Realistic user accounts beyond the existing `operator` and `admin` demo users.
