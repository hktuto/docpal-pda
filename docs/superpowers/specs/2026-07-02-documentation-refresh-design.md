# Documentation Refresh Design

## Goal
Bring project documentation up to date so new users and coding agents can understand the app, its data model, and how to work on it.

## Scope

Three deliverables:

1. **README.md** — refresh the existing user-facing project guide.
2. **docs/database-relations.md** — new reference document describing tables, relations, and allocation lifecycle.
3. **AGENTS.md** — new instruction file for coding agents.

## A. README.md changes

### Fixes
- Replace `cd apps/web-demo` with `cd <project-root>` in the running instructions.
- Fix the project structure tree path from `apps/web-demo/` to the actual project root.

### New features to mention
- **OCR-assisted picking on receiving detail**: on the Picking tab, a scan button opens a modal where the operator types label data (part number, quantity, date/lot code, origin). The system matches it to linked receiving and picking records and applies the pick.
- **Pending picking order count badge**: the receiving list shows how many distinct picking orders still need stock from each receiving order.

### Routes table updates
- Clarify `/receiving/:id` has two views: **Receiving** (invoices/items) and **Picking** (linked picking orders + scan).
- No new public routes are added.

### Project structure updates
- Add new top-level directories/files:
  - `components/OcrScanModal.vue`
  - `composables/useMockOcr.ts`
  - `composables/useOcrPicking.ts`
  - `db/ocrPicking.ts`
  - `docs/superpowers/`
- Keep existing entries accurate.

### Limitations updates
- State that scanning is currently typed input, not camera OCR.
- Note there is no automated test suite yet; verification is manual.

## B. docs/database-relations.md

### Content
- **Mermaid ER diagram** showing all tables and foreign-key relationships.
- **Per-table summary**: table name, purpose, key columns, and what it references.
- **Relation rules**:
  - `receiving_invoice_items` feed `inventory_lots` either directly (receiving-area lots) or through `inventory_lot_sources` (traceability).
  - `picking_items` reserve stock via `allocations`, which point to either an `inventory_lot` or a `receiving_invoice_item`.
  - `shelf_boxes` and `shipping_boxes` group items for put-away and shipping.
  - `transition_logs` records state changes for major entities.
- **Allocation lifecycle**:
  1. Created by `allocate.ts` when stock is available.
  2. Materialized into a dedicated receiving-area lot by `db/picking.ts` before picking.
  3. Picked quantity is confirmed, reducing or deleting the allocation.
  4. Fully picked allocations are removed.

## C. AGENTS.md

### Content
- **Project type**: Nuxt 3 SPA (`ssr: false`), Vue 3 + TypeScript, PGlite in-browser Postgres, Drizzle ORM.
- **Commands**: `pnpm install`, `pnpm dev`, `pnpm nuxt prepare`, `pnpm build`.
- **Conventions**:
  - Follow existing patterns; make minimal, focused changes.
  - Keep files small and single-responsibility.
  - Use `useLiveQuery` for reactive list pages.
  - Put DB helpers in `db/` and composables in `composables/`.
- **Testing**: no automated tests; verify with `pnpm nuxt prepare` and manual browser checks.
- **Feature workflow**: for non-trivial changes, write a spec in `docs/superpowers/specs/` and a plan in `docs/superpowers/plans/` before coding.
- **Demo limitations**:
  - No migrations; schema changes require clearing IndexedDB.
  - Passwords are plain-text demo values.
  - IndexedDB is per-browser.

## Out of scope
- Rewriting the existing `doc/` design documents.
- Adding a full developer architecture guide beyond the relation doc.
