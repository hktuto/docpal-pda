# Warehouse Web Demo

A Nuxt 3 proof-of-concept for the DocPal warehouse mobile/Android flows. The web (PDA) app is a thin client that talks to the `apps/backend` Hono + PostgreSQL API over HTTP (JWT-auth); it also ships as an Android app via Capacitor (`apps/web/android`). A desktop admin console (`apps/admin`) manages master data and orders through the same backend.

---

## Documentation

- [App documentation (manual + AI lookup)](./docs/app-docs/README.md) — training guides for operators and a feature registry for coding agents.
- [Backend database schema](./docs/backend/schema-tables.md) — table-by-table PostgreSQL schema of `apps/backend`.
- [Backend docs](./docs/backend/README.md) — API overview, event catalog, deployment.
- [Agent instructions](./AGENTS.md) — conventions and commands for coding agents.

---

## What it demonstrates

The demo models an event-driven warehouse with two overlapping workflows that share the same inventory. The full outbound chain is **picking → measuring → verify → shipping**, where measuring and verify are optional steps the warehouse can turn on/off (see *Flow-step config* below).

### Workflow A: a receiving order arrives first

1. A supplier shipment arrives as a `receiving_order` with invoices and items.
2. The worker confirms the order is here.
3. The system creates receiving-area inventory lots and immediately tries to allocate them to any not-yet-fully-targeted picking orders.
4. The worker can open the receiving order in **Picking view** to see which picking orders need goods from this shipment and scan packages out of the receiving-area stock.
   - Each line has its own **Scan** button, so the worker can scan directly into that picking item without choosing from multiple orders.
   - The worker can also use the global **scan button** on the Picking tab to type label data (part number, quantity, date/lot code, and origin country). The system matches the input to linked receiving and picking records and creates a scanned package.
   - A **search box** filters the linked picking orders by order number, part number, date code, or lot code.
   - Each picking order number is a link to the full picking order detail page.
5. On the picking order detail page the worker creates shipping boxes. The system auto-generates box IDs such as `BOX-S-20260720-0001`.
6. The worker adds scanned packages into boxes. Once every package for a picking item is in a box, the item is finished.
7. If any stock is left over, the worker can **Shelve (put away)** the remainder into a shelf box. The system logs where every item went.
8. When a picking order is fully boxed, it flips to `finished` — the packed boxes move on to measuring (no task is created at finish; closing a box is the measuring completion, and each closed box gets a verify task when the verify step is on).

### Workflow B: a picking order arrives first

1. A new `picking_order` is created (in a real system this comes from an API).
2. The system looks at all current stock — shelves, shelf boxes, and receiving-area lots — and allocates targets for every line.
3. The worker collects the items. If a receiving order arrives later, its stock is also considered for future picking orders or for re-allocating remaining quantities.

### Supporting actions

- **Receiving** — confirm arrivals, report mismatches, create receiving-area inventory lots, see at a glance how many picking orders still need stock from each receiving order, and pick directly into linked picking orders from the Picking view.
- **Picking** — collect allocated items from shelves or directly from receiving-area lots.
- **Picking by receiving** — look at one receiving order and see every picking order consuming its stock.
- **Shelve / Put-away** — move unallocated receiving-area stock into a shelf box; this creates new shelved inventory for future picking.
- **Goods Verify** — day-end count of the lots that had stock movements.
- **Measuring** — verify and weigh open shipping boxes, then close them (a box may hold packages from several orders). Weights are in **kg** (decimals); the net weight is auto-calculated from the part net-weight master and pre-filled. A single **Confirm box** action saves and closes a box — closing IS the measuring completion; there is no measuring task.
- **Verify** — a second worker re-scans every package of a closed box (works on the sealed box) before it can ship; the box's verify task can only complete when everything has been re-scanned.
- **Stock Search** — look up where a part is stored (shelf, box, quantities).
- **Flow config** — the per-warehouse `warehouse_config` row `"flow"` (JSON merged over defaults, seeded; `FLOW_CONFIG` env override; legacy `FLOW_STEPS_DISABLED` deprecated but still works) turns individual steps (`receiving`/`put-away`/`picking`/`goods-verify`/`measuring`/`verify`/`stock-search`) on or off: hidden steps disappear from the PDA home menu, and disabling `verify` skips the box verify task and its shipping-feed gate. `steps.picking.allocation.allowDockStock=false` makes put-away a hard gate — received stock only becomes allocatable to picking after it is put away.
- **Admin console** (`apps/admin`) — desktop UI for master data (suppliers, parts, shelves, sub-inventories, net-weight formulas, …), picking-order priority, issue handling, audit logs, and a per-box shipping feed (`GET /shipping-orders`: closed, unshipped boxes — gated on the box's completed verify task when the verify step is enabled).

---

## Tech stack

- **Web (PDA) app:** Nuxt 3 SPA (`ssr: false`), Vue 3, plain CSS — `apps/web`
- **Mobile shell:** Capacitor (Android platform in `apps/web/android`)
- **Backend:** Hono + Drizzle ORM + PostgreSQL (JWT auth, SSE event stream) — `apps/backend`, port `3002`
- **Admin console:** Nuxt 3 SPA — `apps/admin`, port `3100`
- **Data access:** the PDA app calls `WarehouseService`/`AuthService`, which speak HTTP to the backend through a single adapter layer (`apps/web/services/adapters/`); all business rules and data live server-side
- **i18n:** shared Nuxt layer `layers/i18n` (en-US / zh-CN / zh-HK) extended by both apps

---

## Entity overview

The full table-by-table schema lives in [docs/backend/schema-tables.md](./docs/backend/schema-tables.md). In outline:

```
users / user_groups / user_group_members
suppliers / supplier_profiles / parts
shelves
sub_inventories                    (org_id + code stock partition groups)

receiving_orders
└── receiving_invoices
    └── receiving_invoice_items    (lot-level detail)
        └── inventory_lot_sources  (traceability link)
            └── inventory_lots     (stock view, partitioned by org_id + sub_inventory_code)

picking_orders
└── picking_items
    ├── allocations                (picking_item → inventory_lot, reserved not yet scanned)
    └── picking_packages           (physical packages scanned then boxed)

verify_tasks                     (one per shipping box, created on box close)
shipping_boxes                   (created in picking, packed with picking_packages; shipped per box)

shelf_boxes                        (created during put-away)
└── shelf_box_items                (verified during goods verify)

goods_verify_tasks                 (day-end counts from inventory_transactions)
transaction_logs                   (audit trail)
inventory_transactions             (stock ledger)
```

### Key design points

- **Inventory is location-aware and partitioned by org + sub-inventory.** A located lot is unique by part/date/lot/origin/location; stock is partitioned by the pair `org_id` + `sub_inventory_code`, with cross-store sharing declared via `sub_inventory_share_members`.
- **Traceability.** `inventory_lot_sources` links every lot back to the originating `receiving_invoice_item`.
- **Allocations reserve stock; packages track physical units.** When a receiving order becomes `in_hand`, pending picking orders are allocated against matching lots (in `picking_orders.priority_seq` order). Scanning an allocation creates a `picking_packages` row and consumes source stock. Boxing a package assigns it to a `shipping_box` and marks quantity as picked.
- **Shipping boxes are created during picking.** Box IDs are auto-generated as `BOX-<kind>-<YYYYMMDD>-<seq>` (kind `S` = shipping, `H` = shelf; per-day sequence).
- **Everything is audited.** Mutations write `transaction_logs` rows and stock movements write `inventory_transactions` ledger rows, all inside the same transaction.

---

## Data flow

### Receiving and inventory creation

- A `receiving_order` arrives with one or more `receiving_invoices`.
- Each invoice has `receiving_invoice_items` describing expected part, quantity, date code, lot code, and origin country.
- The operator confirms arrival. For each item the system creates an `inventory_lots` row in the **receiving area** with `total_qty = received_qty`.
- If the operator reports a mismatch, `received_qty` is the actual quantity and the mismatch is recorded for admin follow-up.
- After confirmation, the system automatically tries to allocate the new stock to pending picking orders.

### Allocation

- Allocation is the central matching engine. It runs whenever new stock appears (receiving confirmed) or a new picking order appears.
- For each `picking_item` that still needs quantity, the system looks for matching lots with available quantity in this order:
  1. Lots already on a shelf or in a shelf box (in-stock).
  2. Lots in the receiving area (just arrived, not yet put away).
- An `allocations` row records how much of each lot is reserved. The reserved quantity reduces the lot's `available_qty`.
- Demands are allocated in `picking_orders.priority_seq` order; an order being actively worked on (live work lock) is skipped by the recompute.

### Picking

- The operator opens a picking order and sees its allocated lots.
- **Scan package** consumes the allocation and source stock, then creates a `picking_packages` row with `shipping_box_id = NULL`. The package is now "scanned".
- The operator creates one or more `shipping_boxes`. The system auto-generates the box ID as `BOX-S-<YYYYMMDD>-<seq>`.
- **Add to box** sets `picking_packages.shipping_box_id` and recalculates the item's picked quantity as the sum of boxed package quantities.
- When every item is fully boxed, the operator finishes the order. No task is created — closing a box is the measuring completion, and each closed box gets a `verify_tasks` row when the verify step is enabled.

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
  - Creates or updates a shelf lot for the shelf box.
  - Updates `inventory_lot_sources` on both sides to preserve traceability.
  - Inserts a `shelf_box_items` row.
- Once shelved, that stock becomes available for future picking orders exactly like any other shelved lot.

### Goods Verify

- Day-end count tasks are generated automatically (nightly job) from the lots that had `inventory_transactions` movements.
- The operator counts the lot and confirms with the actual quantity; a mismatch writes an ADJUST ledger row.

### Measuring

- There is no measuring task — the measuring page lists the open shipping boxes that contain packages (a box may hold packages from several picking orders).
- The operator scans each package in a box to verify it, then records box size, destination country, and net/gross weight in **kg** (decimals; the net weight is pre-filled with the auto-calculated value from the part net-weight master and can be adjusted).
- A single **Confirm box** action saves the measurements and closes the box — closing IS the measuring completion, and when the verify step is enabled a `verify_tasks` row is created for the box.

### Verify

- A second full check of a closed box: the operator re-scans every package (scanning works on the sealed box), and can reopen the box to correct measurements.
- The box's task can only complete when every package has been re-scanned; after that the box is ready to ship and appears in the admin shipping feed.

---

## Routes

| Path | Purpose |
|------|---------|
| `/` | Main menu (tiles for enabled flow steps only) |
| `/login` | Login |
| `/receiving` | List receiving orders (filter: All / Pending / In hand) |
| `/receiving/:id` | Receiving order detail; **Receiving** view shows invoices/items, **Picking** view shows linked picking orders, per-item scan, search, and order links |
| `/picking` | List active picking orders |
| `/picking/:id` | Picking order detail: scan packages, create boxes, add packages to boxes |
| `/put-away` | List receiving orders ready for put-away |
| `/put-away/:id` | Create shelf box and move receiving-area stock |
| `/goods-verify` | List day-end goods-verify tasks |
| `/measuring` | List open shipping boxes that contain packages |
| `/measuring/:boxId` | Verify packages, weigh (kg), and confirm/close the shipping box |
| `/verify` | List boxes with a pending verify task |
| `/verify/:boxId` | Re-scan the box's packages, then complete its verify task |
| `/stock-search` | Search stock by part / supplier |
| `/box` | Cross-flow box lookup (shipping + shelf boxes) |

---

## Running the demo

The demo needs **two servers** (plus PostgreSQL):

```bash
docker compose up -d            # shared local PostgreSQL
pnpm install
pnpm dev:backend                # backend API on :3002 (migrations + demo seed run automatically)
pnpm --filter @warehouse/web dev   # PDA web app on :3000
pnpm dev:admin                  # optional: admin console on :3100
```

Then open the web URL and log in with one of the demo accounts:

| Username | Password |
|----------|----------|
| `operator` | `DocPal2026!` |
| `admin` | `DocPalAdmin2026!` (admin console) |

### Scanning demo labels

The Camera OCR demo needs `apps/web/public/ocr-labels.html` to be present in the build. It is a 7-step demo flow helper that guides you through receiving → picking → measuring → put-away → goods verify; scan labels only on the steps marked "Scan step". The old flat label catalog is preserved at `apps/web/public/ocr-labels-backup.html`. Display the page on a monitor or another device and point the Android camera at each label instead of printing physical labels. Open it at:

```text
http://<dev-server-ip>:3000/ocr-labels.html
```

The page loads [JsBarcode](https://github.com/lindell/JsBarcode) and [node-qrcode](https://github.com/soldair/node-qrcode) from a CDN to render real Code 128 barcodes and QR codes, so the display device needs internet access. See `docs/superpowers/specs/2026-07-04-ocr-labels-demo-flow-design.md` for full details.

### Production build

`docker-compose.prod.yml` runs the full stack (db + backend + web + admin) as containers; see [AGENTS.md](./AGENTS.md) for the commands and required env.

### Reset the demo data

`POST :3002/dev/reset` truncates the database and re-seeds it. The **⋮ → Reset database** control in the PDA app header calls the same endpoint.

---

## Project structure

This is a pnpm monorepo:

- `apps/web` — Nuxt 3 PDA client (+ Capacitor Android shell)
- `apps/backend` — Hono + Drizzle + PostgreSQL API (schema in `src/db/schema/`)
- `apps/admin` — Nuxt 3 desktop admin console
- `layers/i18n` — shared i18n layer
- `docs/` — app documentation, backend docs, design specs

See [AGENTS.md](./AGENTS.md) for the detailed layout, commands, and conventions, and [docs/app-docs/ai/code-map.md](./docs/app-docs/ai/code-map.md) for a page/component ↔ source-file map.

---

## Notes and limitations

- **Demo passwords only.** The seed uses well-known demo passwords (`operator` / `DocPal2026!`, `admin` / `DocPalAdmin2026!`); they are scrypt-hashed, but change them before any real deployment.
- **Shared PostgreSQL dataset.** Data persists across restarts and is shared by everyone on the same backend; use the reset control to start fresh. Migrations auto-apply on backend startup, and the demo dataset is seeded when the `users` table is empty.
- **Allocation is greedy.** It fills shelved lots first, then receiving-area lots, in priority-seq order, without partial date-code relaxation or FIFO beyond the required date code filter.
- **Scanning.** Camera/barcode capture is implemented via the native Android `RectangleDetection.scanLabel()` flow; on PDA hardware the scanner service's intent broadcast is received through the `ScannerBroadcast` Capacitor plugin, with a keyboard-wedge fallback for browsers and unconfigured devices. The parsing logic normalizes input and applies simple OCR-style substitutions (e.g. `O` → `0`) so the demo can simulate real scan errors.
- **Tests.** Backend: `pnpm --filter @warehouse/backend test` (node:test, needs PostgreSQL). Web: `pnpm --filter @warehouse/web test` (vitest).
