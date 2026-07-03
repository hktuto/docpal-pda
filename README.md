# Warehouse Web Demo

A client-side Nuxt 3 proof-of-concept for the DocPal warehouse mobile/Android flows. It runs a full Postgres database in the browser using PGlite, so the demo works without a backend.

---

## What it demonstrates

The demo models an event-driven warehouse with two overlapping workflows that share the same inventory.

### Workflow A: a receiving order arrives first

1. A supplier shipment arrives as a `receiving_order` with invoices and items.
2. The worker confirms the order is here.
3. The system creates receiving-area inventory lots and immediately tries to allocate them to any not-yet-fully-targeted picking orders.
4. The worker can open the receiving order in **Picking view** to see which picking orders need goods from this shipment and scan packages out of the receiving-area stock.
   - Each line has its own **Scan** button, so the worker can scan directly into that picking item without choosing from multiple orders.
   - The worker can also use the global **scan button** on the Picking tab to type label data (part number, quantity, date/lot code, and origin country). The system matches the input to linked receiving and picking records and creates a scanned package.
   - A **search box** filters the linked picking orders by order number, part number, date code, or lot code.
   - Each picking order number is a link to the full picking order detail page.
5. On the picking order detail page the worker creates shipping boxes. The system auto-generates box IDs such as `BOX-HK1-WWYY000001`.
6. The worker adds scanned packages into boxes. Once every package for a picking item is in a box, the item is finished.
7. If any stock is left over, the worker can **Shelve (put away)** the remainder into a shelf box. The system logs where every item went.
8. When a picking order is fully boxed, a measuring task is created so the boxes can be weighed and closed.

### Workflow B: a picking order arrives first

1. A new `picking_order` is created (in a real system this comes from an API).
2. The system looks at all current stock — shelves, shelf boxes, and receiving-area lots — and allocates targets for every line.
3. The worker collects the items. If a receiving order arrives later, its stock is also considered for future picking orders or for re-allocating remaining quantities.

### Supporting actions

- **Receiving** — confirm arrivals, report mismatches, create receiving-area inventory lots, see at a glance how many picking orders still need stock from each receiving order, and pick directly into linked picking orders from the Picking view.
- **Picking** — collect allocated items from shelves or directly from receiving-area lots.
- **Picking by receiving** — look at one receiving order and see every picking order consuming its stock.
- **Shelve / Put-away** — move unallocated receiving-area stock into a shelf box; this creates new shelved inventory for future picking.
- **Goods Verify** — verify the contents of a closed shelf box.
- **Measuring** — pack picked items into shipping boxes and record weights/size/destination.

---

## Tech stack

- **Framework:** Nuxt 3 (`ssr: false`)
- **UI:** Vue 3, plain CSS
- **Database:** PGlite — WebAssembly build of Postgres running in the browser
- **ORM:** Drizzle ORM with the `drizzle-orm/pglite` driver
- **Persistence:** IndexedDB via PGlite (`idb://warehouse-demo-pglite`)
- **List pages:** Manual `db.execute` queries that reload on mount and when the app regains visibility (Capacitor does not support `useLiveQuery`).

---

## Entity overview

```
users
suppliers
parts
shelves

receiving_orders
└── receiving_invoices
    └── receiving_invoice_items   (lot-level detail)
        └── inventory_lot_sources  (traceability link)
            └── inventory_lots     (stock view, unique by part/date/lot/origin/location when located)

picking_orders
└── picking_items
    ├── allocations                (picking_item → inventory_lot, reserved not yet scanned)
    └── picking_packages           (physical packages scanned then boxed)

measuring_tasks
└── shipping_boxes                 (created in picking, packed with picking_packages)

shelf_boxes                       (created during put-away)
└── shelf_box_items               (verified during goods verify)

transition_logs                   (all status changes)
```

### Key design points

- **Inventory is location-aware.** A located lot is unique by `(part_id, date_code, lot_code, origin_country, shelf_code, box_id)`. Receiving-area lots (`shelf_code = NULL, box_id = NULL`) are created per materialized allocation so each one has a single `inventory_lot_sources` link; once put away they become located lots and merge by the unique key.
- **Traceability.** `inventory_lot_sources` links every lot back to the originating `receiving_invoice_item`.
- **Allocations reserve stock; packages track physical units.** When a receiving order becomes `in_hand`, pending picking orders are allocated against matching lots. Scanning an allocation creates a `picking_packages` row and consumes source stock. Boxing a package assigns it to a `shipping_box` and marks quantity as picked.
- **Shipping boxes are created during picking.** Box IDs are auto-generated as `BOX-HK1-WWYY######` (warehouse `HK1`, ISO week, two-digit year, per-week sequence).
- **State transitions are logged.** Every status change for receiving orders, picking orders, shelf boxes, shipping boxes, picking items, and measuring tasks writes a row to `transition_logs`.

---

## Data flow

### Receiving and inventory creation

- A `receiving_order` arrives with one or more `receiving_invoices`.
- Each invoice has `receiving_invoice_items` describing expected part, quantity, date code, lot code, and origin country.
- The operator confirms arrival. For each item the system creates an `inventory_lots` row in the **receiving area** (`shelf_code = NULL, box_id = NULL`) with `total_qty = received_qty`.
- If the operator reports a mismatch, `received_qty` is the actual quantity and `reported_mismatch` is set.
- After confirmation, the system automatically tries to allocate the new stock to pending picking orders.

### Allocation

- Allocation is the central matching engine. It runs whenever new stock appears (receiving confirmed) or a new picking order appears.
- For each `picking_item` that still needs quantity, the system looks for matching lots with available quantity in this order:
  1. Lots already on a shelf or in a shelf box (in-stock).
  2. Lots in the receiving area (just arrived, not yet put away).
- An `allocations` row records how much of each lot is reserved. The reserved quantity reduces the lot's `available_qty`.
- Shelved stock is consumed first because it is already organized; receiving-area stock is used only when shelved stock is insufficient.

### Picking

- The operator opens a picking order and sees its allocated lots.
- **Scan package** consumes the allocation and source stock, then creates a `picking_packages` row with `shipping_box_id = NULL`. The package is now "scanned".
- The operator creates one or more `shipping_boxes`. The system auto-generates the box ID as `BOX-HK1-WWYY######`.
- **Add to box** sets `picking_packages.shipping_box_id` and recalculates `picking_items.picked_qty` as the sum of boxed package quantities.
- Once `picking_items.picked_qty` reaches the required quantity, the item is finished.
- When every item is fully boxed, the operator finishes the order. The system creates a `measuring_tasks` row with status `pending`.

### Picking directly from a receiving order

- On the receiving order detail page, the operator can switch to **Picking view**.
- This view groups the receiving order's stock by the related picking orders and shows exactly which items and quantities need to be picked out of this shipment.
- Each picking item has a **Scan** button that applies the typed label directly to that item, avoiding the multi-order chooser.
- A **search box** filters the list by picking order number, part number, date code, or lot code.
- Each picking order number links to the full picking order detail page.
- Picking here creates scanned packages against the same receiving-area lots as the normal picking flow. The worker then opens the picking order detail page to box them.

### Shelving / Put-away

- Put-away is not a sequential task; it is an action the worker takes whenever unallocated receiving-area stock should become regular shelf inventory.
- The operator selects a receiving order, chooses a shelf, and creates a `shelf_box`.
- The operator moves quantity from receiving-area lots into the shelf box.
- The system:
  - Decreases the receiving-area lot `total_qty`.
  - Creates or updates a shelf lot (`shelf_code = box.shelfCode, box_id = box.id`).
  - Updates `inventory_lot_sources` on both sides to preserve traceability.
  - Inserts a `shelf_box_items` row.
- Once shelved, that stock becomes available for future picking orders exactly like any other shelved lot.

### Goods Verify

- After a shelf box is closed, the operator can verify it.
- The box shows the expected items and quantities.
- The operator scans/enters a part number. The system marks the first matching unverified `shelf_box_items` row as verified.
- When all items are verified, the operator marks the box verified. The system sets `shelf_boxes.status = 'verified'` and logs the transition.

### Measuring

- When a picking order is finished, a pending `measuring_tasks` row exists and the shipping boxes were already created and packed during picking.
- For each open box the operator can set gross/net weight, destination country, and box size.
- The operator reviews the packages already inside each box.
- When a box is ready, the operator closes it. The system logs `shipping_box:{id} open → closed`.
- When all shipping boxes are closed and every picking item is fully packed, the operator can complete the measuring task. The system sets `measuring_tasks.status = 'completed'` and logs the transition.

---

## Routes

| Path | Purpose |
|------|---------|
| `/` | Main menu |
| `/login` | Login |
| `/receiving` | List receiving orders (filter: All / Pending / In hand) |
| `/receiving/:id` | Receiving order detail; **Receiving** view shows invoices/items, **Picking** view shows linked picking orders, per-item scan, search, and order links |
| `/picking` | List active picking orders |
| `/picking/:id` | Picking order detail: scan packages, create boxes, add packages to boxes |
| `/put-away` | List receiving orders ready for put-away |
| `/put-away/:id` | Create shelf box and move receiving-area stock |
| `/goods-verify` | List shelves with shelf boxes |
| `/goods-verify/shelf/:code` | List shelf boxes on a shelf |
| `/goods-verify/box/:id` | Verify items in a shelf box |
| `/measuring` | List pending measuring tasks |
| `/measuring/:id` | Review, weigh, and close shipping boxes |

---

## Running the demo

```bash
pnpm install
pnpm run dev
```

Then open the local URL and log in with one of the demo accounts:

| Username | Password |
|----------|----------|
| `operator` | `DocPal2026!` |
| `admin` | `DocPalAdmin2026!` |

### Production build

```bash
pnpm run build
```

### Reset the demo data

The database lives in the browser's IndexedDB. Use the **⋮ → Reset local DB** menu in the app, or clear site data for the origin. The next load will re-seed with fresh demo data.

---

## Project structure

```
├── app.vue                  # PGlite bootstrap, schema init, seed, auth restore
├── assets/                  # Global styles and static assets
│   └── css/main.css         # Global styles
├── capacitor.config.ts      # Capacitor native shell configuration
├── components/
│   ├── AppHeader.vue        # Header with back button, reset DB, logout
│   ├── BoxMeasurementsModal.vue  # Edit shipping box weight/size/destination
│   ├── DetailHeader.vue     # Reusable detail page header and status chip
│   └── LabelScanReviewModal.vue  # Review camera-scanned label matches
├── composables/
│   ├── useAndroidBackButton.ts   # Handle Android hardware back button
│   ├── useAuth.ts           # Login/logout/restore
│   ├── useCurrentUser.ts    # Current operator helper
│   ├── useDb.ts             # Drizzle client from provided PGlite
│   ├── useLabelScan.ts      # Scan label parsing and matching state
│   ├── useMockOcr.ts        # Parses typed label input for the scan modal
│   ├── useRecognizedTextParser.ts  # Normalize and parse OCR text
│   ├── useRectangleDetection.ts    # Native Android rectangle/label detection
│   └── useScanMatchers.ts   # Matching utilities for scan results
├── constants/               # App constants
│   └── pocOptions.ts
├── db/
│   ├── allocate.ts          # Allocation logic (shelved first, then arrivals)
│   ├── goodsVerify.ts       # Goods verify DB helpers
│   ├── init.ts              # Raw Postgres DDL for first-time bootstrap
│   ├── measuring.ts         # Measuring / shipping box helpers
│   ├── ocrPicking.ts        # OCR-assisted picking matching and apply logic
│   ├── picking.ts           # Picking DB helpers
│   ├── putAway.ts           # Put-away DB helpers
│   ├── receiving.ts         # Receiving DB helpers
│   ├── schema.ts            # Drizzle pg-core table definitions (includes picking_packages)
│   └── seed.ts              # Demo users, suppliers, parts, orders, inventory
├── docs/
│   └── superpowers/         # Design specs and implementation plans
│       ├── specs/
│       └── plans/
├── layouts/                 # Nuxt layouts
│   └── default.vue
├── middleware/              # Nuxt route middleware
│   └── auth.global.ts       # Global auth guard
├── nuxt.config.ts           # Nuxt configuration
├── pages/
│   ├── login.vue            # Login page
│   ├── index.vue            # Menu / home page
│   ├── receiving/
│   ├── picking/
│   ├── put-away/
│   ├── goods-verify/
│   └── measuring/
├── patches/                 # pnpm package patches
├── plugins/                 # Nuxt client plugins
│   └── pglite.client.ts     # PGlite client plugin
├── public/                  # Static public assets
├── scripts/                 # Build/dev helper scripts
└── package.json
```

---

## Notes and limitations

- **Demo only.** Passwords are stored as plain text hashes in the seed file; this is acceptable for a local proof-of-concept only.
- **Single-browser database.** Because PGlite stores data in IndexedDB, each browser has its own isolated demo database.
- **No migrations.** The schema is created once from `db/init.ts` when the `users` table does not exist. Schema changes require clearing IndexedDB.
- **Allocation is greedy.** It fills shelved lots first, then receiving-area lots, without partial date-code relaxation or FIFO beyond the required date code filter.
- **Scanning supports camera input.** Camera/barcode integration is implemented via the native Android `RectangleDetection.scanLabel()` flow. On supported devices the operator can scan a label with the camera; the detected text is parsed and matched to receiving and picking records just like typed input. A typed-input fallback is still available for browsers and testing. The parsing logic normalizes input and applies simple OCR-style substitutions (e.g. `O` → `0`) so the demo can simulate real scan errors.
- **Limited automated tests.** There is a small Android unit-test suite for the OpenCV crop logic (`./gradlew :app:testDebugUnitTest`). Most verification is still manual browser testing plus `pnpm nuxt prepare` for TypeScript generation.
