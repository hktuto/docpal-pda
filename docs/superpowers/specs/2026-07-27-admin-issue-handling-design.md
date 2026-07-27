# Admin issue handling — receiving mismatches & picking order issues

Date: 2026-07-27
Status: approved (resolve = back to pending + re-allocate; cancel-order flow deferred)

## Problem

The PDA lets operators report two kinds of issues, but the admin console has no way to see or handle them:

1. **Receiving item mismatch** — flat columns on `receiving_invoice_items` (`reported_mismatch`, `mismatch_reason`, `mismatch_qty`, `wrong_part_no`, `mismatch_note`). Full lifecycle exists via flow routes (`GET/POST/PATCH /receiving-invoice-items/:id/mismatch`, `POST .../mismatch/confirm`, `POST .../mismatch/cancel`), but there is no cross-order list, so an admin cannot find open mismatches without opening every order. `confirm` is a pure audit acknowledgment; only `cancel` clears the flag.
2. **Picking order issue** — `POST /picking-orders/report-issues` sets `status='issue'` + `issue_*` columns, which blocks scanning/unpacking (409 `picking_order_has_open_issue`) and excludes the order from `allocateAll`. There is **no transition out of `issue`** — the lifecycle is a dead end.

Neither flow emits SSE events, so open PDA pages go stale when issues are reported/resolved.

## Decisions

- Resolving a picking issue always means: back to `status='pending'`, clear the `issue_*` columns, re-run `allocateAll`. Reason-specific fixes (stock arrival, pack-size data fix, etc.) are done by the admin *before* resolving — the resolve action itself is dumb.
- Cancel-order (close as unfulfillable) is a separate flow, deferred.
- Receiving mismatches keep their existing semantics; admin only needs a list view + confirm/cancel actions wired to the existing routes.

## Backend changes (`apps/backend`)

### 1. `POST /picking-orders/:id/resolve-issue`

- Route in `src/routes/picking.ts`, domain fn `resolvePickingOrderIssue` in `src/db/picking.ts`.
- Body: `{ actorId, resolutionNote? }` (actorId from JWT per existing convention).
- 409 `picking_order_no_open_issue` unless `status='issue'`; 404 `picking_order_not_found`.
- In one tx: set `status='pending'`, NULL all `issue_*` columns, write `transaction_logs` row (`entity_type='picking_order'`, fromState `'issue'`, toState `'pending'`, metadata `{ reason: <old reason>, resolutionNote }`).
- After commit: best-effort `allocateAll()` + `emitEvent` (topic `/picking-orders`, e.g. `picking_order.updated`) following existing event patterns in `src/db/events.ts`.

### 2. `GET /admin/receiving-mismatches`

- New router `src/routes/admin/issues.ts` (mounted under `/admin`).
- Returns items where `reported_mismatch = true`, joined to order + invoice: `{ itemId, receivingOrderId, batchNo, invoiceId, invoiceNo, partNo, supplierCode, reason, mismatchQty, wrongPartNo, note }`. Newest first.
- Confirm/cancel reuse the existing flow routes (`POST /receiving-invoice-items/:id/mismatch/confirm|cancel`) — admin JWT already passes auth.

### 3. SSE events

- `emitEvent` (topic `/receiving-orders`) on mismatch report/edit/confirm/cancel in `src/db/receiving.ts`.
- `emitEvent` (topic `/picking-orders`) on issue report and resolve in `src/db/picking.ts`.

### 4. Tests

- `src/db/picking.test.ts`: report → resolve → status `pending`, issue columns NULL, log row written, order participates in allocation again; resolve on non-issue order → 409.
- Mismatch list query coverage (report two items across orders → list returns both with joins).

## Admin changes (`apps/admin`)

Follow the flow-page pattern (`utils/flowApi.ts` wrappers + inline-action style of `pages/receiving/[id].vue`).

1. `utils/flowApi.ts`: typed wrappers — `listReceivingMismatches()`, `confirmReceivingMismatch(itemId)`, `cancelReceivingMismatch(itemId)`, `resolvePickingIssue(orderId, resolutionNote?)`. Also declare the already-returned `mismatch` field on `ReceivingItemRow` and the `issue_*` fields on `PickingOrderDetail`.
2. New nav section "Issues" in `navSections` (`utils/entities.ts`) with two links:
   - `pages/issues/receiving.vue` — table of open mismatches with per-row Confirm / Cancel actions, reload + error banner per existing pattern.
   - `pages/issues/picking.vue` — `GET /picking-orders?status=issue` list showing reason/qty/pack size/note/reported-at, per-row Resolve (optional note via `prompt()` or small inline input).
3. Existing detail pages: render `mismatch` on `pages/receiving/[id].vue` rows; render `issue_*` fields + Resolve action on `pages/picking-orders/[id].vue`.
4. i18n: `admin.navLinks.issues*` + `admin.pages.issues.*` keys in all three locales (`layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`); reuse `admin.common.*` where possible.

## Docs

- Update `AGENTS.md` route summary (new endpoints).
- Update `docs/app-docs/flows/receiving/ai-scope.md` and `docs/app-docs/flows/picking/ai-scope.md` (admin resolution path + new endpoints).

## Out of scope

- Cancel-order resolution for picking issues.
- Stock/qty correction semantics for receiving mismatches (confirm stays an acknowledgment).
