# Native Android Rewrite — Design Spec

Date: 2026-07-12
Status: Approved (design)

## Goal

Build a full native Android version of the warehouse PDA app (`apps/web`) with
feature parity, using on-device Android SQLite (Room) as the database. The app
works fully offline, just like the current PGlite-in-browser demo, but with a
persistent database that survives app restarts.

## Decisions (from brainstorming)

- **Data layer:** on-device SQLite via Room, fully offline. No dependency on
  `apps/api` (that backend remains a separate effort).
- **Stack:** Kotlin + Jetpack Compose, Navigation-Compose, MVVM.
- **Scope:** full feature parity with `apps/web`, built in phases.
- **Scanning:** port the existing Java camera pipeline (OpenCV rectangle
  detection + ML Kit OCR/barcode) from `apps/web/android` unchanged.
- **Persistence:** seed once on first launch; data persists across restarts;
  provide a "reset demo data" action.

## Architecture

New Gradle module at `apps/android` (sibling of `apps/web` and `apps/api`).

- **applicationId:** `com.docpal.warehousepda` — distinct from the Capacitor
  app's `com.docpal.warehousedemo` so both can be installed side by side.
- **Package root:** `com.docpal.warehousepda`
- **SDK levels:** minSdk 24, compileSdk/targetSdk 36 (same as
  `apps/web/android`).

Three layers:

### `data/`

- Room database with entities and DAOs for all tables listed below.
- Repositories mirroring the query/mutation modules in `apps/web/db/*.ts`:
  - `AuthRepository` ← `useAuth` / auth service
  - `ReceivingRepository` ← `db/receiving.ts`, `db/mismatch.ts`
  - `PickingRepository` ← `db/picking.ts`, `db/ocrPicking.ts`
  - `AllocationRepository` ← `db/allocate.ts`
  - `PutAwayRepository` ← `db/putAway.ts`
  - `GoodsVerifyRepository` ← `db/goodsVerify.ts`
  - `MeasuringRepository` ← `db/measuring.ts`
  - `StockSearchRepository` ← `db/stockSearch.ts`
  - `SupplierRepository` ← `db/suppliers.ts`
- `transition_logs` writes happen inside the same repositories, in the same
  Room transaction as the state change (mirrors web behavior).

### `domain/`

- Label/OCR parsing: Kotlin port of `useMockOcr.ts` (`parseManual`,
  `normalize`) plus supplier QR templates (`suppliers.qrcode_template`,
  `qrcode_qty_encoding`).
- Scan matchers: port of `useScanMatchers.ts` (receive, pick, put-away,
  verify contexts) — find candidates, apply scan, return review data.
- Allocation logic: port of `db/allocate.ts` rules (lot selection, qty
  splits, `inventory_lot_sources` provenance).
- Status/badge mapping: port of `useStatusBadge.ts` / `useStatusLabel.ts`.
- `I18nError` equivalent for localized error messages.

### `ui/`

- One Compose screen per web route (see Flows below), each backed by a
  ViewModel exposing StateFlow-based UI state.
- Shared primitives ported 1:1 from `apps/web/components`:
  `AppHeader`, `DetailHeader`, `DetailRow`, `EmptyState`, `ScanFab`,
  toast host, status badges, `LabelScanReviewModal`, `CandidateChips`,
  `ReportIssueModal`, `SelectShelfDialog`, `BoxMeasurementsModal`,
  `LanguageSwitcher`.
- Per-flow sub-components under `ui/<flow>/` mirroring
  `apps/web/components/<flow>/`.
- List screens refresh on resume (equivalent of `useVisibleReload`).

## Database schema

Room entities for every table in `apps/web/db/schema.ts`:

| Area | Tables |
|---|---|
| Reference | `users`, `suppliers`, `parts`, `shelves` |
| Receiving | `receiving_orders`, `receiving_invoices`, `receiving_invoice_items`, `receiving_item_mismatches` |
| Picking | `picking_orders`, `picking_items`, `picking_packages` |
| Inventory | `inventory_lots`, `inventory_lot_sources`, `allocations` |
| Measuring/boxes | `measuring_tasks`, `shipping_boxes`, `shelf_boxes`, `put_away_scans` |
| Audit | `transition_logs` |

Notes:

- `inventory_lots.available_qty` is a generated column in the web schema;
  SQLite supports generated columns and Room maps them as read-only fields.
- The partial unique index on located lots is recreated via
  `@Index` + a raw index statement in the Room database callback (Room
  cannot express `WHERE` clauses in annotations).
- Enums (`status`, `reason`, `source_type`, …) stay as TEXT columns with
  CHECK constraints, matching the web schema; Kotlin enums + TypeConverters
  on the app side.
- Database version starts at 1. Since there is no shipped user data,
  `fallbackToDestructiveMigration()` is acceptable for the POC; proper
  migrations are out of scope.

## Seeding

Hand-porting `apps/web/db/seed.ts` (~6.7k lines) is error-prone. Instead:

1. Add a small Node export script under `apps/web/scripts/` that boots the
   seeded PGlite database and dumps all tables to a plain SQLite-compatible
   SQL file (`apps/android/app/src/main/assets/seed.sql`).
2. The app imports `seed.sql` in Room's `onCreate` callback (single
   transaction), which runs automatically on first launch and after any
   destructive migration — no separate "seeded" flag is needed.
3. A "Reset demo data" action (on the login screen and/or app header menu)
   deletes all rows and re-runs the seed script.

Seed content: 2 users (`operator` / `DocPal2026!`, admin), 26 suppliers,
~177 parts, 11 shelves, 1 receiving order with 16 invoices / 264 invoice
items, 23 picking orders with 73 picking items — identical to the web demo.

## Scanning

- Move these Java files unchanged from `apps/web/android` into
  `apps/android` under a `scanner/` package:
  `RectangleCameraActivity`, `RectangleDetector`, `RectangleTracker`,
  `RectangleOverlayView`, `RectanglePickerActivity`, `RectangleCropper`,
  `RectangleOcrHelper`, `OcrBarcodeProcessor`, `RectangleResultJson`.
- Expose to Compose via `ActivityResultLauncher`; result contract matches
  today's `{ imagePath, text, barcodes }` payload.
- Keep the existing OpenCV crop-ordering unit test
  (`RectangleCropperOrderPointsTest`) and move it with the code.
- Hardware keyboard-wedge scanner: intercept key events at the screen /
  activity level, buffer until Enter (port of `useHardwareScanner.ts`).
- Manual entry fallback stays available everywhere a scan is possible.

Native dependencies (same versions as `apps/web/android`): ML Kit
text-recognition 16.0.1, ML Kit barcode-scanning 17.3.0, OpenCV 4.13.0,
CameraX 1.3.4.

## Flows (screens)

1. **Login** — username/password against seeded `users`; session held in
   memory + DataStore; i18n locale switch (en-US, zh-CN, zh-HK).
2. **Home** — 6 cards: Receiving, Picking, Put Away, Goods Verify,
   Measuring, Stock Search.
3. **Receiving** — order list (filterable by status) → detail with Items
   tab (scan to receive, report mismatch: 6 reasons) and Picking tab
   (allocate received qty to picking orders); confirm arrival; mark clear.
4. **Picking** — order list with multi-select + batch issue report
   (4 reasons) → detail: items with allocation progress, box sections,
   scan-to-pick (creates packages), create/cancel shipping boxes,
   add-all-unboxed, remove packages, finish (spawns measuring task).
5. **Put-away** — receiving order list → detail: create/scan shelf-box
   labels, scan items into shelf boxes, lots panel, close boxes.
6. **Goods verify** — shelf list → boxes on shelf → box detail: scan each
   put-away item to verify; close verified box.
7. **Measuring** — task list → task detail (boxes) → per-box: gross/net
   weight, box size, destination country, verify packages by scan, close
   box; complete task.
8. **Stock search** — read-only supplier/part inventory lookup with lot +
   shelf/box location stats.
9. **Labels** — receiving label sheets rendered on-device (barcode/QR via
   an Android barcode library), shareable/printable via Android print
   framework.

## Build phases

| Phase | Content | Exit criteria |
|---|---|---|
| 0 | Gradle module, Compose theme, nav skeleton, Room DB + entities/DAOs, seed export script + import, login, home, i18n plumbing | App installs, seeds, login works, home shows 6 cards |
| 1 | Receiving (list, detail, scan-to-receive, mismatches, allocation, clear) | Web receiving flow reproducible end-to-end on device |
| 2 | Picking (list + batch issue, detail, scan-to-pick, boxes, finish → measuring task) | Picking flow reproducible; finish creates measuring task |
| 3 | Put-away (shelf boxes, item scans, lots) | Put-away flow reproducible |
| 4 | Goods verify (shelf → box drill-down, verify scans, close) | Verify flow reproducible |
| 5 | Measuring (tasks, per-box measurements, package verify, complete) | Measuring flow reproducible |
| 6 | Stock search + Labels | Search returns correct lot/location stats; label sheets render |
| 7 | Polish: i18n completeness, empty states, toasts, reset-demo-data | Full walkthrough in all 3 locales; reset works |

The scanner pipeline is moved in Phase 0 (needed by Phase 1) and exercised
first in the receiving flow.

## Testing

- **JVM unit tests** for domain logic: label parsing (`parseManual`
  parity cases taken from web behavior), allocation rules, scan matchers —
  run against in-memory Room.
- **Repository tests** with in-memory Room for non-trivial transactions
  (receive-and-allocate, finish-picking → measuring task spawn).
- **Scanner:** keep `RectangleCropperOrderPointsTest` running via
  `./gradlew :app:testDebugUnitTest`.
- **Manual verification per phase:** build and install on a device/emulator,
  walk the corresponding web flow side by side with the same seed data.
- No instrumented UI test suite for the POC (out of scope).

## Out of scope

- Sync or communication with `apps/api`.
- iOS.
- Instrumented UI/E2E test automation.
- Room schema migrations (destructive fallback only).
- Changes to `apps/web` or the Capacitor app, except the additive seed
  export script.

## Risks

- **Seed dump fidelity:** PGlite (Postgres) → SQLite dialect differences
  (generated columns, partial indexes, timestamps). Mitigation: the export
  script dumps data only (INSERT statements); schema is defined natively in
  Room/SQLite.
- **Allocation logic subtlety:** `db/allocate.ts` + `db/picking.ts` hold the
  most complex business rules. Mitigation: port with unit tests written
  from web behavior before wiring UI.
- **OpenCV/ML Kit footprint:** large native dependencies (~30+ MB APK).
  Acceptable for an internal POC.
