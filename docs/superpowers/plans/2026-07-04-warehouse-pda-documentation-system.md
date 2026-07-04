# Warehouse PDA Documentation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Markdown-only documentation system under `docs/app-docs/` that serves warehouse operators/trainers and AI coding agents, with a placeholder for future screenshots.

**Architecture:** Feature-centric folder structure. Each major flow has `overview.md`, `steps.md`, and `ai-scope.md`. Shared concepts, components, and composables live in their own folders. An `ai/` folder provides a feature registry, scope template, and code map. A top-level `README.md` ties everything together. Screenshots are deferred but a placeholder folder is created.

**Tech Stack:** Markdown only. No code changes to the Nuxt app.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `docs/app-docs/README.md` | Home page, TOC, how to use this documentation. |
| `docs/app-docs/concepts/overview.md` | What the app is, demo limitations. |
| `docs/app-docs/concepts/roles.md` | Login and operator role. |
| `docs/app-docs/concepts/navigation.md` | Home screen, menu, app header, language switcher. |
| `docs/app-docs/concepts/data-model.md` | Core entities in business terms. |
| `docs/app-docs/flows/index.md` | Flow summary / quick-reference matrix. |
| `docs/app-docs/flows/<flow>/*.md` | Per-flow user guides and AI scope blocks. |
| `docs/app-docs/components/*.md` | Shared and flow-specific UI components. |
| `docs/app-docs/composables/*.md` | Composable quick-reference and one-pagers. |
| `docs/app-docs/ai/feature-registry.md` | Machine-readable feature → files index. |
| `docs/app-docs/ai/scope-remark-template.md` | Standard format for AI scope blocks. |
| `docs/app-docs/ai/code-map.md` | Page/component ↔ source-file mapping. |
| `docs/app-docs/assets/screenshots/.gitkeep` | Placeholder for future screenshots. |
| `docs/app-docs/assets/screenshots/README.md` | Naming convention for future screenshots. |
| `README.md` | Add a "Documentation" section linking to `docs/app-docs/README.md`. |

---

### Task 1: Create directory structure

**Files:**
- Create directories: `docs/app-docs/concepts/`, `docs/app-docs/flows/picking/`, `docs/app-docs/flows/receiving/`, `docs/app-docs/flows/put-away/`, `docs/app-docs/flows/measuring/`, `docs/app-docs/flows/goods-verify/`, `docs/app-docs/components/`, `docs/app-docs/composables/`, `docs/app-docs/ai/`, `docs/app-docs/assets/screenshots/`

- [ ] **Step 1: Create all directories**

Run:
```bash
mkdir -p docs/app-docs/concepts \
  docs/app-docs/flows/picking \
  docs/app-docs/flows/receiving \
  docs/app-docs/flows/put-away \
  docs/app-docs/flows/measuring \
  docs/app-docs/flows/goods-verify \
  docs/app-docs/components \
  docs/app-docs/composables \
  docs/app-docs/ai \
  docs/app-docs/assets/screenshots
```

- [ ] **Step 2: Verify directories exist**

Run:
```bash
find docs/app-docs -type d | sort
```

Expected output includes all directories listed above.

---

### Task 2: Create top-level README and entry point

**Files:**
- Create: `docs/app-docs/README.md`

- [ ] **Step 1: Write `docs/app-docs/README.md`**

```markdown
# Warehouse PDA App Documentation

This manual explains the warehouse PDA demo app for **operators and trainers**, and provides a lookup reference for **AI coding agents**.

## Quick links

- [Concepts](./concepts/overview.md) — what the app is, who uses it, and how it is organized.
- [Flows](./flows/index.md) — step-by-step guides for each warehouse operation.
- [Components](./components/shared-components.md) — shared UI building blocks.
- [Composables](./composables/index.md) — reusable Vue logic.
- [AI Feature Registry](./ai/feature-registry.md) — machine-readable feature index for agents.

## For operators and trainers

Start with [Concepts → Overview](./concepts/overview.md), then follow the flow you need:

1. [Picking](./flows/picking/overview.md)
2. [Receiving](./flows/receiving/overview.md)
3. [Put-away](./flows/put-away/overview.md)
4. [Measuring](./flows/measuring/overview.md)
5. [Goods verify](./flows/goods-verify/overview.md)

## For AI agents

- Use [feature-registry.md](./ai/feature-registry.md) to find which files implement a feature.
- Use each flow's `ai-scope.md` to understand boundaries and limitations.
- Use [code-map.md](./ai/code-map.md) for page/component ↔ source-file mappings.

## Project references

- [Root README](../../README.md) — setup and quick-start.
- [AGENTS.md](../../AGENTS.md) — coding conventions and commands.
- [Database relations](../database-relations.md) — ER diagram and table summary.
- [Design specs](../superpowers/specs/) — per-feature design documents.
```

- [ ] **Step 2: Verify the file renders**

Open `docs/app-docs/README.md` in a Markdown viewer or editor and confirm the relative links look correct.

---

### Task 3: Create concept pages

**Files:**
- Create: `docs/app-docs/concepts/overview.md`
- Create: `docs/app-docs/concepts/roles.md`
- Create: `docs/app-docs/concepts/navigation.md`
- Create: `docs/app-docs/concepts/data-model.md`

- [ ] **Step 1: Write `docs/app-docs/concepts/overview.md`**

```markdown
# Overview

The Warehouse PDA app is a client-side Nuxt 3 proof-of-concept for warehouse mobile/Android flows. It runs a full Postgres database in the browser using PGlite, so the demo works without a backend.

## What it demonstrates

- Receiving incoming shipments.
- Putting received goods away onto shelves.
- Picking items for outgoing orders.
- Measuring and packing shipping boxes.
- Verifying goods during the process.

## Key design ideas

- **Mobile-first.** The UI is built for a handheld Android device.
- **Offline-capable demo.** PGlite stores the database in the browser's IndexedDB.
- **No backend.** All data lives in the browser; this is for demonstration and training only.

## Demo limitations

- **No migrations.** The schema is created once from `db/init.ts`. Schema changes require clearing IndexedDB.
- **Demo passwords only.** Passwords are stored as plain-text hashes in the seed file.
- **Per-browser database.** Each browser/device has its own isolated demo database.
- **Typed scanning.** Camera OCR exists on Android for label capture in some flows, but much scanning is simulated by typed input.
- **No automated test suite.** Verification is manual browser testing plus `pnpm nuxt prepare`.

## Who should read this

- Warehouse operators learning the app.
- Trainers preparing onboarding material.
- AI agents that need a high-level understanding before diving into code.
```

- [ ] **Step 2: Write `docs/app-docs/concepts/roles.md`**

```markdown
# Roles and Login

## User role

The demo has a single operator role. There is no admin/operator split in the UI today.

## Login

1. Open the app.
2. Enter username `operator`.
3. Enter password `DocPal2026!`.
4. Tap **Login**.

## After login

The app shows the home screen with the main menu. Use the menu to choose a warehouse flow.

## Language

Operators can switch language using the language switcher in the app header. Supported languages are configured in `i18n/config.ts` and live under `i18n/locales/`.
```

- [ ] **Step 3: Write `docs/app-docs/concepts/navigation.md`**

```markdown
# Navigation

## Home screen

The home screen (`pages/index.vue`) shows the main menu cards:

- Receiving
- Put-away
- Picking
- Measuring
- Goods Verify

Tap a card to enter that flow.

## App header

`components/AppHeader.vue` appears on most screens and provides:

- A back button to return to the previous screen.
- A reset-database button (demo only).
- A logout button.
- A language switcher (`components/LanguageSwitcher.vue`).

## Detail pages

Most flows follow a list → detail pattern:

1. A list page shows open orders/tasks.
2. Tapping an item opens a detail page.
3. The detail page shows header information and action rows.
4. A floating action button (`ScanFab`) often opens a scan or action modal.

## Common UI patterns

- **DetailHeader** — order/task title, status badge, and summary.
- **DetailRow** — a labeled value row used throughout detail pages.
- **StatusBadge** — colored badge showing a task/order state.
- **EmptyState** — shown when a list has no items.
- **ScanFab** — circular floating button that triggers a scan or action.
```

- [ ] **Step 4: Write `docs/app-docs/concepts/data-model.md`**

```markdown
# Data Model (Business View)

These are the core entities an operator works with. For the full database schema, see [Database Relations](../database-relations.md).

## Receiving order

An incoming shipment from a supplier. It contains one or more invoices, and each invoice contains line items (parts).

## Picking order

An outgoing shipment to a customer/supplier. It contains line items that must be picked from inventory.

## Inventory lot

A quantity of a specific part, identified by part number, date/lot code, origin, and location (shelf or box).

## Allocation

A reservation of stock for a picking item. An allocation points to an inventory lot or directly to a receiving invoice item.

## Shelf box

A box created during put-away that groups items moved onto a shelf.

## Shipping box

A box created during measuring/packing that groups items shipped to a customer.

## Measuring task

A packing task created when a picking order is finished. The operator measures shipping boxes and records dimensions.

## Transition log

An audit trail of status changes for orders, boxes, and tasks.
```

---

### Task 4: Create flow index

**Files:**
- Create: `docs/app-docs/flows/index.md`

- [ ] **Step 1: Write `docs/app-docs/flows/index.md`**

```markdown
# Flows

The app supports five warehouse flows. Each flow has an overview, a step-by-step operator guide, and an AI scope document.

| Flow | Purpose | Entry page | Operator guide | AI scope |
|------|---------|------------|----------------|----------|
| [Picking](./picking/overview.md) | Pick items from inventory to fulfill outgoing orders. | `/picking` | [Steps](./picking/steps.md) | [Scope](./picking/ai-scope.md) |
| [Receiving](./receiving/overview.md) | Confirm incoming shipments and create receiving-area stock. | `/receiving` | [Steps](./receiving/steps.md) | [Scope](./receiving/ai-scope.md) |
| [Put-away](./put-away/overview.md) | Move received goods from receiving area onto shelves. | `/put-away` | [Steps](./put-away/steps.md) | [Scope](./put-away/ai-scope.md) |
| [Measuring](./measuring/overview.md) | Measure and pack shipping boxes for finished picking orders. | `/measuring` | [Steps](./measuring/steps.md) | [Scope](./measuring/ai-scope.md) |
| [Goods Verify](./goods-verify/overview.md) | Verify goods at appropriate process points. | `/goods-verify` | [Steps](./goods-verify/steps.md) | [Scope](./goods-verify/ai-scope.md) |

## Common actions across flows

- **Scanning / label entry** — many flows use `useLabelScan` and `LabelScanReviewModal` to capture part numbers, quantities, dates, lot codes, and origins.
- **Issue reporting** — operators can report shortages, damages, or mismatches through `ReportIssueModal` / `PickingIssueReportModal`.
- **Status tracking** — each order/box/task has a status shown by `StatusBadge` and recorded in `transition_logs`.
```

---

### Task 5: Create picking documentation

**Files:**
- Create: `docs/app-docs/flows/picking/overview.md`
- Create: `docs/app-docs/flows/picking/steps.md`
- Create: `docs/app-docs/flows/picking/label-scan.md`
- Create: `docs/app-docs/flows/picking/issue-reporting.md`
- Create: `docs/app-docs/flows/picking/ai-scope.md`

- [ ] **Step 1: Write `docs/app-docs/flows/picking/overview.md`**

```markdown
# Picking Overview

Picking is the process of removing items from inventory to fulfill outgoing picking orders.

## When to use it

Use the Picking flow when a picking order is ready and stock has been allocated.

## Concept

1. The operator opens the Picking list.
2. The operator selects a picking order.
3. The app shows allocated lines and suggested lots/boxes.
4. The operator picks each line, confirming quantity and location.
5. Optional: the operator can scan a supplier label to auto-match and apply a pick (OCR-assisted picking).
6. When all lines are picked, the picking order is finished.

## Related guides

- [Step-by-step operator guide](./steps.md)
- [Label scan / OCR-assisted picking](./label-scan.md)
- [Issue reporting](./issue-reporting.md)
- [AI scope](./ai-scope.md)
```

- [ ] **Step 2: Write `docs/app-docs/flows/picking/steps.md`**

```markdown
# Picking Steps

## 1. Open the picking list

From the home screen, tap **Picking**. The list shows open picking orders with status and summary information.

## 2. Select a picking order

Tap the order you want to work on. The detail page opens.

## 3. Review allocated lines

The detail page shows each picking item, the required quantity, and where the stock is allocated from (lot or receiving-area item).

## 4. Pick each line

- Tap a line or the scan button.
- Confirm the part number and quantity.
- Confirm the source location.
- The picked quantity is recorded and the allocation is reduced or removed.

## 5. Handle issues

If the quantity is wrong, the item is damaged, or stock cannot be found, use the issue-reporting flow. See [Issue reporting](./issue-reporting.md).

## 6. Finish the order

When all lines are fully picked, the order status changes to finished and a measuring task may be created.
```

- [ ] **Step 3: Write `docs/app-docs/flows/picking/label-scan.md`**

```markdown
# Label Scan / OCR-Assisted Picking

Some picking flows allow the operator to scan or type a supplier label. The system parses the label text and tries to match it to linked receiving and picking records.

## What the parser expects

Typical label fields:

- Part number
- Quantity
- Date / lot code
- Origin country

## How it works

1. The operator taps the scan button on the Picking tab of a receiving detail.
2. The `LabelScanReviewModal` opens.
3. The operator enters or confirms label data.
4. `useLabelScan` and `useScanMatchers` parse and normalize the input.
5. `db/ocrPicking.ts` matches the parsed data to receiving invoice items and picking items.
6. If a unique match is found, the pick is applied automatically.

## Known behavior

- The demo normalizes common OCR errors (for example, `O` → `0`).
- If the input does not match exactly one record, the operator must review or correct it.
```

- [ ] **Step 4: Write `docs/app-docs/flows/picking/issue-reporting.md`**

```markdown
# Picking Issue Reporting

If an operator cannot pick the expected quantity, or the goods are damaged, they can report an issue.

## How to report

1. On the picking detail, tap the report/issue action.
2. Select the issue type (for example, shortage, damage).
3. Enter the affected quantity and any notes.
4. Submit.

## Result

The issue is recorded. Depending on the implementation, the picking item status or allocation may be adjusted.

## Related components

- `components/PickingIssueReportModal.vue`
- `components/ReportIssueModal.vue`
```

- [ ] **Step 5: Write `docs/app-docs/flows/picking/ai-scope.md`**

```markdown
# Picking — AI Scope and Remarks

## In scope

- List open picking orders.
- Show picking order detail with allocated lines.
- Confirm picks by quantity and source location.
- OCR-assisted picking via typed label input on the receiving detail Picking tab.
- Issue reporting for shortages/damages.
- Finish a picking order and create a measuring task.

## Out of scope

- Real camera barcode scanning (typed input / Android native rectangle detection only).
- Wave picking or batch picking across multiple orders.
- Pick-to-light or voice picking.
- Integration with external WMS/ERP.

## Key files

- `pages/picking/` — list and detail pages.
- `components/picking/` — picking-specific components.
- `composables/useLabelScan.ts` — label parsing.
- `composables/useScanMatchers.ts` — matching logic.
- `composables/useMockOcr.ts` — OCR normalization demo.
- `db/picking.ts` — picking DB helpers.
- `db/ocrPicking.ts` — OCR-assisted picking apply logic.
- `db/allocate.ts` — allocation creation.

## Known limitations

- Typed input simulates scanning; the Android native `RectangleDetection.scanLabel()` path is used in some camera flows but not all.
- Matching depends on normalized text and may require manual review.
- No backend validation; all logic runs client-side in PGlite.

## Related specs/plans

- `docs/superpowers/specs/2026-07-01-ocr-assisted-picking-design.md`
- `docs/superpowers/specs/2026-07-03-picking-issue-reporting-design.md`
- `docs/superpowers/specs/2026-07-03-package-level-picking-design.md`
```

---

### Task 6: Create receiving documentation

**Files:**
- Create: `docs/app-docs/flows/receiving/overview.md`
- Create: `docs/app-docs/flows/receiving/steps.md`
- Create: `docs/app-docs/flows/receiving/mismatch-handling.md`
- Create: `docs/app-docs/flows/receiving/ai-scope.md`

- [ ] **Step 1: Write `docs/app-docs/flows/receiving/overview.md`**

```markdown
# Receiving Overview

Receiving is the process of confirming incoming shipments and creating receiving-area inventory.

## When to use it

Use the Receiving flow when a supplier shipment arrives at the warehouse.

## Concept

1. The operator opens the Receiving list.
2. The operator selects a receiving order.
3. The order detail shows invoices and invoice items.
4. The operator confirms quantities and reports any mismatches.
5. Confirmed items create receiving-area inventory lots.
6. The Receiving list can also show how many picking orders still need stock from each receiving order.

## Views on the detail page

- **Receiving view** — invoices and items.
- **Picking view** — linked picking orders and the scan modal for OCR-assisted picking.

## Related guides

- [Step-by-step operator guide](./steps.md)
- [Mismatch handling](./mismatch-handling.md)
- [AI scope](./ai-scope.md)
```

- [ ] **Step 2: Write `docs/app-docs/flows/receiving/steps.md`**

```markdown
# Receiving Steps

## 1. Open the receiving list

From the home screen, tap **Receiving**. The list shows receiving orders with status and a pending picking-order count badge.

## 2. Select a receiving order

Tap the order you want to receive. The detail page opens on the Receiving view.

## 3. Review invoices and items

The detail shows each invoice and each line item (part, expected quantity, received quantity).

## 4. Confirm or adjust quantities

- If the physical quantity matches, confirm the line.
- If the quantity differs, report a mismatch. See [Mismatch handling](./mismatch-handling.md).

## 5. Create receiving-area inventory

Confirmed items become receiving-area inventory lots that can be picked or put away.

## 6. Switch to Picking view (optional)

Tap **Picking** to see linked picking orders and use OCR-assisted picking to consume receiving-area stock directly.
```

- [ ] **Step 3: Write `docs/app-docs/flows/receiving/mismatch-handling.md`**

```markdown
# Receiving Mismatch Handling

A mismatch occurs when the physical shipment does not match the expected invoice.

## Types of mismatch

- **Shortage** — fewer items arrived than expected.
- **Overage** — more items arrived than expected.
- **Wrong item** — a different part arrived.
- **Damage** — items arrived damaged.

## How to report

1. On the receiving detail, tap the mismatch/issue action for the affected line.
2. Select the mismatch type.
3. Enter the actual quantity or notes.
4. Submit.

## Result

The mismatch is recorded in the audit log and the invoice item status is updated. Inventory creation may be adjusted accordingly.
```

- [ ] **Step 4: Write `docs/app-docs/flows/receiving/ai-scope.md`**

```markdown
# Receiving — AI Scope and Remarks

## In scope

- List receiving orders.
- Show receiving order detail with invoices and items.
- Confirm received quantities.
- Report receiving mismatches (shortage, overage, wrong item, damage).
- Create receiving-area inventory lots.
- Show pending picking order count badge on the list.
- Two views on detail: Receiving and Picking.
- OCR-assisted picking from the Picking view.

## Out of scope

- ASN (advance shipping notice) import.
- Supplier label printing.
- Integration with carrier tracking.
- Quality inspection hold statuses.

## Key files

- `pages/receiving/` — list and detail pages.
- `components/receiving/` — receiving-specific components.
- `db/receiving.ts` — receiving DB helpers.
- `db/init.ts` — schema bootstrap.

## Known limitations

- Demo-only data; no real supplier integration.
- Mismatch resolution rules are simplified.

## Related specs/plans

- `docs/superpowers/specs/2026-07-01-receiving-list-picking-order-count-design.md`
- `docs/superpowers/specs/2026-07-03-receiving-mismatch-design.md`
```

---

### Task 7: Create put-away documentation

**Files:**
- Create: `docs/app-docs/flows/put-away/overview.md`
- Create: `docs/app-docs/flows/put-away/steps.md`
- Create: `docs/app-docs/flows/put-away/ai-scope.md`

- [ ] **Step 1: Write `docs/app-docs/flows/put-away/overview.md`**

```markdown
# Put-away Overview

Put-away is the process of moving received goods from the receiving area onto warehouse shelves.

## When to use it

Use the Put-away flow after receiving has created receiving-area inventory and the goods need to be stored.

## Concept

1. The operator opens the Put-away list.
2. The operator selects a put-away task or receiving order.
3. The app shows items available to move.
4. The operator scans or selects a shelf destination.
5. The operator moves items into a shelf box.
6. The inventory lot is updated with the new shelf location.

## Related guides

- [Step-by-step operator guide](./steps.md)
- [AI scope](./ai-scope.md)
```

- [ ] **Step 2: Write `docs/app-docs/flows/put-away/steps.md`**

```markdown
# Put-away Steps

## 1. Open the put-away list

From the home screen, tap **Put-away**. The list shows orders/tasks waiting to be put away.

## 2. Select a task

Tap the task to open the detail page.

## 3. Review available items

The detail shows the receiving-area items that can be moved.

## 4. Choose a destination shelf

Tap the shelf selection action or scan the shelf barcode/label.

## 5. Move items

- Enter the quantity to move.
- Confirm the move.
- The system creates or updates a shelf box and moves the inventory lot to the shelf.

## 6. Finish

When all items are put away, the task/order status is updated.
```

- [ ] **Step 3: Write `docs/app-docs/flows/put-away/ai-scope.md`**

```markdown
# Put-away — AI Scope and Remarks

## In scope

- List put-away tasks.
- Show detail with receiving-area items.
- Select a destination shelf.
- Move items into shelf boxes.
- Update inventory lot locations.

## Out of scope

- Automated put-away suggestions based on velocity or zone.
- Forklift or robot integration.
- Multi-step directed put-away with confirmation checkpoints.

## Key files

- `pages/put-away/` — list and detail pages.
- `components/put-away/` — put-away-specific components.
- `components/SelectShelfDialog.vue` — shelf selection UI.
- `db/putAway.ts` — put-away DB helpers.

## Known limitations

- Shelf selection is manual.
- No validation of shelf capacity or restrictions.

## Related specs/plans

- `docs/superpowers/specs/2026-07-03-cancel-empty-box-design.md`
```

---

### Task 8: Create measuring documentation

**Files:**
- Create: `docs/app-docs/flows/measuring/overview.md`
- Create: `docs/app-docs/flows/measuring/steps.md`
- Create: `docs/app-docs/flows/measuring/box-measurements.md`
- Create: `docs/app-docs/flows/measuring/ai-scope.md`

- [ ] **Step 1: Write `docs/app-docs/flows/measuring/overview.md`**

```markdown
# Measuring Overview

Measuring is the process of recording shipping-box dimensions and packing items after a picking order is finished.

## When to use it

Use the Measuring flow when a picking order status becomes finished and a measuring task is created.

## Concept

1. The operator opens the Measuring list.
2. The operator selects a measuring task.
3. The task detail shows the picking order and items to pack.
4. The operator creates shipping boxes.
5. The operator records length, width, height, and weight for each box.
6. The operator packs items into the boxes.

## Related guides

- [Step-by-step operator guide](./steps.md)
- [Box measurements](./box-measurements.md)
- [AI scope](./ai-scope.md)
```

- [ ] **Step 2: Write `docs/app-docs/flows/measuring/steps.md`**

```markdown
# Measuring Steps

## 1. Open the measuring list

From the home screen, tap **Measuring**. The list shows measuring tasks for finished picking orders.

## 2. Select a measuring task

Tap the task to open the detail page.

## 3. Review items to pack

The detail shows the picking order lines and quantities that need to be packed.

## 4. Create shipping boxes

Tap the action to add a new shipping box. Each box gets a unique identifier.

## 5. Record measurements

For each box, enter:

- Length
- Width
- Height
- Weight

See [Box measurements](./box-measurements.md) for details.

## 6. Pack items

Assign picking items to boxes. The packed quantity is recorded per box.

## 7. Finish the task

When all items are packed and measurements are recorded, finish the measuring task.
```

- [ ] **Step 3: Write `docs/app-docs/flows/measuring/box-measurements.md`**

```markdown
# Box Measurements

Each shipping box must have its dimensions and weight recorded before the measuring task is finished.

## Required fields

- **Length** — longest side of the box.
- **Width** — second side.
- **Height** — remaining side.
- **Weight** — total weight of the packed box.

## How to enter

1. Open the box detail or the `BoxMeasurementsModal`.
2. Enter each dimension.
3. Save.

## Validation

The demo may apply simple validation (positive numbers, reasonable ranges). The exact rules are defined in `db/measuring.ts` and the measuring page components.

## Related components

- `components/BoxMeasurementsModal.vue`
```

- [ ] **Step 4: Write `docs/app-docs/flows/measuring/ai-scope.md`**

```markdown
# Measuring — AI Scope and Remarks

## In scope

- List measuring tasks for finished picking orders.
- Show task detail with items to pack.
- Create shipping boxes.
- Record box measurements (length, width, height, weight).
- Pack picking items into shipping boxes.
- Finish the measuring task.

## Out of scope

- Carrier rate shopping.
- Label printing for shipping boxes.
- Integration with scales or dimensioners.
- Multi-package shipment optimization.

## Key files

- `pages/measuring/` — list and detail pages.
- `components/BoxMeasurementsModal.vue` — measurement entry.
- `db/measuring.ts` — measuring DB helpers.

## Known limitations

- Measurements are typed manually.
- No real weight or dimension capture.

## Related specs/plans

- `docs/superpowers/specs/2026-07-02-measuring-flow-design.md`
- `docs/superpowers/specs/2026-07-03-boxes-section-redesign-design.md`
```

---

### Task 9: Create goods-verify documentation

**Files:**
- Create: `docs/app-docs/flows/goods-verify/overview.md`
- Create: `docs/app-docs/flows/goods-verify/steps.md`
- Create: `docs/app-docs/flows/goods-verify/ai-scope.md`

- [ ] **Step 1: Write `docs/app-docs/flows/goods-verify/overview.md`**

```markdown
# Goods Verify Overview

Goods Verify is the process of checking/verifying goods at the appropriate warehouse step.

## When to use it

Use the Goods Verify flow when an explicit verification step is required for incoming or outgoing goods.

## Concept

1. The operator opens the Goods Verify list.
2. The operator selects a verification task.
3. The app shows the expected goods.
4. The operator scans or confirms each item.
5. The verification result is recorded.

## Related guides

- [Step-by-step operator guide](./steps.md)
- [AI scope](./ai-scope.md)
```

- [ ] **Step 2: Write `docs/app-docs/flows/goods-verify/steps.md`**

```markdown
# Goods Verify Steps

## 1. Open the goods verify list

From the home screen, tap **Goods Verify**. The list shows pending verification tasks.

## 2. Select a task

Tap the task to open the detail page.

## 3. Review expected items

The detail shows the items to verify, usually with part number, quantity, and expected location.

## 4. Verify each item

- Scan or type the part number.
- Confirm the quantity.
- Mark the item as verified or report an issue.

## 5. Complete the task

When all items are verified, finish the task. Any discrepancies are logged.
```

- [ ] **Step 3: Write `docs/app-docs/flows/goods-verify/ai-scope.md`**

```markdown
# Goods Verify — AI Scope and Remarks

## In scope

- List goods-verify tasks.
- Show task detail with expected items.
- Scan/type part numbers for verification.
- Record verification results and discrepancies.

## Out of scope

- Automated quality inspection.
- Photo capture for proof of condition.
- Integration with QA systems.

## Key files

- `pages/goods-verify/` — list and detail pages.
- `db/goodsVerify.ts` — goods verify DB helpers.

## Known limitations

- Verification is a simplified demo flow.
- No image or signature capture.
```

---

### Task 10: Create component documentation

**Files:**
- Create: `docs/app-docs/components/shared-components.md`
- Create: `docs/app-docs/components/flow-components.md`

- [ ] **Step 1: Write `docs/app-docs/components/shared-components.md`**

```markdown
# Shared Components

These components are reused across multiple flows.

## AppHeader

`components/AppHeader.vue`

Top header with back button, reset DB, logout, and language switcher.

## DetailHeader

`components/DetailHeader.vue`

Page header for detail pages: title, status badge, and summary row.

## DetailRow

`components/DetailRow.vue`

Simple labeled-value row used throughout detail pages.

## StatusBadge

`components/StatusBadge.vue`

Colored badge showing an entity status. Driven by `composables/useStatusBadge.ts`.

## EmptyState

`components/EmptyState.vue`

Placeholder shown when a list has no items.

## ScanFab

`components/ScanFab.vue`

Circular floating action button that triggers a scan or primary action.

## LanguageSwitcher

`components/LanguageSwitcher.vue`

Dropdown/button to switch the app language.

## Modals

- `components/LabelScanReviewModal.vue` — review and submit scanned label data.
- `components/BoxMeasurementsModal.vue` — enter shipping box dimensions.
- `components/ReportIssueModal.vue` — generic issue reporting.
- `components/PickingIssueReportModal.vue` — picking-specific issue reporting.
- `components/SelectShelfDialog.vue` — choose a destination shelf.
```

- [ ] **Step 2: Write `docs/app-docs/components/flow-components.md`**

```markdown
# Flow-Specific Components

Components organized under `components/<flow>/` are used primarily by that flow.

## Picking components

`components/picking/`

See the folder contents for picking-specific UI pieces.

## Receiving components

`components/receiving/`

See the folder contents for receiving-specific UI pieces.

## Put-away components

`components/put-away/`

See the folder contents for put-away-specific UI pieces.

## Notes for agents

When adding a new flow-specific component, create a folder under `components/<flow>/` and keep it focused on that flow. Shared behavior should be extracted to `composables/` or shared components at the top level.
```

---

### Task 11: Create composables documentation

**Files:**
- Create: `docs/app-docs/composables/index.md`
- Create: `docs/app-docs/composables/useLabelScan.md`
- Create: `docs/app-docs/composables/useScanMatchers.md`

- [ ] **Step 1: Write `docs/app-docs/composables/index.md`**

```markdown
# Composables

Composables live in `composables/` and contain reusable Vue logic.

## Quick reference

| Composable | Purpose |
|------------|---------|
| `useAuth.ts` | Login/logout/restore. |
| `useDb.ts` | Drizzle client from the provided PGlite instance. |
| `useLabelScan.ts` | Parse and manage scanned label input. |
| `useScanMatchers.ts` | Match parsed label data to receiving/picking records. |
| `useMockOcr.ts` | Simulate OCR normalization and errors. |
| `useRectangleDetection.ts` | Android native rectangle detection wrapper. |
| `useStatusBadge.ts` | Status badge styling/state helper. |
| `useStatusLabel.ts` | Status label helper. |
| `useVisibleReload.ts` | Reload data on mount and visibility/focus events for Capacitor. |
| `useAndroidBackButton.ts` | Handle Android hardware back button. |
| `useLocalePreference.ts` | Persist and restore language preference. |
| `useLogStateLabel.ts` | Helper for state-label logging. |
| `useLabelScanReview.ts` | Review-modal state for label scans. |

## Agent note

When a new cross-cutting concern appears, prefer adding a focused composable over duplicating logic in pages or components.
```

- [ ] **Step 2: Write `docs/app-docs/composables/useLabelScan.md`**

```markdown
# useLabelScan

`composables/useLabelScan.ts`

Parses scanned or typed label input into structured fields (part number, quantity, date/lot code, origin).

## When to use

Use this composable when building a scan/label-entry feature.

## Main responsibilities

- Accept raw input text.
- Normalize common OCR substitutions.
- Return structured label fields.
- Expose validation helpers.

## Related files

- `composables/useScanMatchers.ts`
- `composables/useMockOcr.ts`
- `components/LabelScanReviewModal.vue`
```

- [ ] **Step 3: Write `docs/app-docs/composables/useScanMatchers.md`**

```markdown
# useScanMatchers

`composables/useScanMatchers.ts`

Matches parsed label data against receiving invoice items and picking items.

## When to use

Use this composable when implementing OCR-assisted picking or any feature that must link a scanned label to database records.

## Main responsibilities

- Compare parsed fields to records.
- Return candidate matches with confidence.
- Handle ambiguity (multiple matches / no matches).

## Related files

- `composables/useLabelScan.ts`
- `db/ocrPicking.ts`
```

---

### Task 12: Create AI agent reference pages

**Files:**
- Create: `docs/app-docs/ai/feature-registry.md`
- Create: `docs/app-docs/ai/scope-remark-template.md`
- Create: `docs/app-docs/ai/code-map.md`

- [ ] **Step 1: Write `docs/app-docs/ai/feature-registry.md`**

```markdown
# Feature Registry

Machine-readable index of features in the warehouse PDA demo. Use this page to locate implementation files and scope notes.

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Picking list | Picking | Shipped | `pages/picking/index.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking detail | Picking | Shipped | `pages/picking/[id].vue` or equivalent | [ai-scope](../flows/picking/ai-scope.md) |
| OCR-assisted picking | Picking / Receiving | Shipped | `composables/useLabelScan.ts`, `composables/useScanMatchers.ts`, `db/ocrPicking.ts`, `components/LabelScanReviewModal.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking issue reporting | Picking | Shipped | `components/PickingIssueReportModal.vue`, `components/ReportIssueModal.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Receiving list | Receiving | Shipped | `pages/receiving/index.vue` | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving detail | Receiving | Shipped | `pages/receiving/[id].vue` or equivalent | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving mismatch | Receiving | Shipped | `components/ReportIssueModal.vue`, `db/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Pending picking count badge | Receiving | Shipped | `pages/receiving/index.vue`, `db/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Put-away list | Put-away | Shipped | `pages/put-away/index.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Put-away detail | Put-away | Shipped | `pages/put-away/[id].vue` or equivalent | [ai-scope](../flows/put-away/ai-scope.md) |
| Shelf selection | Put-away | Shipped | `components/SelectShelfDialog.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Measuring list | Measuring | Shipped | `pages/measuring/index.vue` | [ai-scope](../flows/measuring/ai-scope.md) |
| Measuring detail | Measuring | Shipped | `pages/measuring/[id].vue` or equivalent | [ai-scope](../flows/measuring/ai-scope.md) |
| Box measurements | Measuring | Shipped | `components/BoxMeasurementsModal.vue`, `db/measuring.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Goods verify list | Goods Verify | Shipped | `pages/goods-verify/index.vue` | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Goods verify detail | Goods Verify | Shipped | `pages/goods-verify/[id].vue` or equivalent | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Login | Auth | Shipped | `pages/login.vue`, `composables/useAuth.ts` | [roles](../concepts/roles.md) |
| Language switcher | Shared | Shipped | `components/LanguageSwitcher.vue`, `composables/useLocalePreference.ts`, `i18n/` | [navigation](../concepts/navigation.md) |

## Status legend

- **Shipped** — feature exists in the current demo.
- **Planned** — not part of this documentation system; see `docs/superpowers/plans/`.
```

- [ ] **Step 2: Write `docs/app-docs/ai/scope-remark-template.md`**

```markdown
# Scope Remark Template

Use this template when writing an `ai-scope.md` file for a new flow or feature.

```markdown
# [Feature/Flow] — AI Scope and Remarks

## In scope

- Bullet list of what the feature does today.

## Out of scope

- Bullet list of what the feature explicitly does not do.

## Key files

- `path/to/page.vue` — responsibility.
- `path/to/component.vue` — responsibility.
- `path/to/composable.ts` — responsibility.
- `path/to/db-helper.ts` — responsibility.

## Known limitations

- Demo-only behavior.
- Hardcoded values.
- Missing backend/integration.

## Related specs/plans

- `docs/superpowers/specs/YYYY-MM-DD-feature-design.md`
- `docs/superpowers/plans/YYYY-MM-DD-feature.md`
```
```

- [ ] **Step 3: Write `docs/app-docs/ai/code-map.md`**

```markdown
# Code Map

Page and component locations mapped to source files.

## Pages

| Page | Route | Source file |
|------|-------|-------------|
| Login | `/login` | `pages/login.vue` |
| Home / Menu | `/` | `pages/index.vue` |
| Picking list | `/picking` | `pages/picking/index.vue` |
| Picking detail | `/picking/:id` | `pages/picking/[id].vue` or equivalent |
| Receiving list | `/receiving` | `pages/receiving/index.vue` |
| Receiving detail | `/receiving/:id` | `pages/receiving/[id].vue` or equivalent |
| Put-away list | `/put-away` | `pages/put-away/index.vue` |
| Put-away detail | `/put-away/:id` | `pages/put-away/[id].vue` or equivalent |
| Measuring list | `/measuring` | `pages/measuring/index.vue` |
| Measuring detail | `/measuring/:id` | `pages/measuring/[id].vue` or equivalent |
| Goods verify list | `/goods-verify` | `pages/goods-verify/index.vue` |
| Goods verify detail | `/goods-verify/:id` | `pages/goods-verify/[id].vue` or equivalent |

## Layouts and global UI

| UI element | Source file |
|------------|-------------|
| Default layout | `layouts/default.vue` |
| App header | `components/AppHeader.vue` |
| Language switcher | `components/LanguageSwitcher.vue` |

## Shared detail primitives

| Component | Source file |
|-----------|-------------|
| DetailHeader | `components/DetailHeader.vue` |
| DetailRow | `components/DetailRow.vue` |
| StatusBadge | `components/StatusBadge.vue` |
| EmptyState | `components/EmptyState.vue` |
| ScanFab | `components/ScanFab.vue` |

## Modals

| Modal | Source file |
|-------|-------------|
| LabelScanReviewModal | `components/LabelScanReviewModal.vue` |
| BoxMeasurementsModal | `components/BoxMeasurementsModal.vue` |
| ReportIssueModal | `components/ReportIssueModal.vue` |
| PickingIssueReportModal | `components/PickingIssueReportModal.vue` |
| SelectShelfDialog | `components/SelectShelfDialog.vue` |

## Database helpers

| Helper | Source file |
|--------|-------------|
| Schema definitions | `db/schema.ts` |
| Bootstrap / init | `db/init.ts` |
| Seed data | `db/seed.ts` |
| Picking | `db/picking.ts` |
| OCR-assisted picking | `db/ocrPicking.ts` |
| Receiving | `db/receiving.ts` |
| Put-away | `db/putAway.ts` |
| Measuring | `db/measuring.ts` |
| Goods verify | `db/goodsVerify.ts` |
| Allocation | `db/allocate.ts` |
```

---

### Task 13: Create screenshot placeholder

**Files:**
- Create: `docs/app-docs/assets/screenshots/.gitkeep`
- Create: `docs/app-docs/assets/screenshots/README.md`

- [ ] **Step 1: Create the placeholder folder contents**

Write `docs/app-docs/assets/screenshots/README.md`:

```markdown
# Screenshots

This folder is reserved for future UI screenshots used in the training manual.

## Naming convention

Use the format:

```
<flow>-<screen>-<description>.png
```

Examples:

- `picking-list-default.png`
- `receiving-detail-invoice.png`
- `measuring-box-measurements-modal.png`

## Guidelines

- Use the same language/state as the demo seed data.
- Capture only the relevant screen area.
- Keep file sizes reasonable (compress PNGs).
- Update the relevant `docs/app-docs/flows/<flow>/steps.md` file to reference the image with a relative link:

```markdown
![Picking list](./../../assets/screenshots/picking-list-default.png)
```

## Current status

No screenshots yet. Placeholder created for future documentation updates.
```

Create an empty `.gitkeep` file so Git tracks the otherwise empty folder:

```bash
touch docs/app-docs/assets/screenshots/.gitkeep
```

---

### Task 14: Update root README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Documentation section to `README.md`**

Find a sensible location near the top of `README.md` (after the intro or quick-start) and add:

```markdown
## Documentation

- [App documentation (manual + AI lookup)](./docs/app-docs/README.md) — training guides for operators and a feature registry for coding agents.
- [Database relations](./docs/database-relations.md) — ER diagram and table reference.
- [Agent instructions](./AGENTS.md) — conventions and commands for coding agents.
```

- [ ] **Step 2: Verify the link resolves**

Open `README.md` and confirm the relative link points to `docs/app-docs/README.md`.

---

## Verification

- [ ] `pnpm nuxt prepare` runs cleanly (no code changes, but confirms nothing is broken).
- [ ] Every relative link in `docs/app-docs/README.md` resolves to an existing file.
- [ ] Every flow directory contains `overview.md`, `steps.md`, and `ai-scope.md`.
- [ ] `docs/app-docs/ai/feature-registry.md` lists every flow and key shared component/composable.
- [ ] `README.md` contains a Documentation section linking to `docs/app-docs/README.md`.
- [ ] No TBD/TODO placeholders remain in the created files.

---

## Self-Review Checklist

- **Spec coverage:**
  - Top-level README — Task 2.
  - Concept pages — Task 3.
  - Flow index — Task 4.
  - Picking docs — Task 5.
  - Receiving docs — Task 6.
  - Put-away docs — Task 7.
  - Measuring docs — Task 8.
  - Goods-verify docs — Task 9.
  - Component docs — Task 10.
  - Composable docs — Task 11.
  - AI reference pages — Task 12.
  - Screenshot placeholder — Task 13.
  - Root README update — Task 14.
- **Placeholder scan:** no TBD/TODO; all content is concrete.
- **Type consistency:** not applicable; documentation only.
