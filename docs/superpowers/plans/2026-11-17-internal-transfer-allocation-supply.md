# Internal Transfer — Allocation Supply (Plan)

Spec: `docs/superpowers/specs/2026-11-17-internal-transfer-allocation-supply-design.md`

## Backend

1. Migration: `allocations.internal_transfer_item_id` (FK, cascade) +
   widened source CHECK + index; NULL out
   `internal_transfer_orders.picking_order_id` (deprecate column).
2. `allocate.ts`: `loadInternalTransferSources` (confirmed orders only,
   pair = receivingSubInventoryRules over item po_no under to_org_id,
   fallback to_sub; supply = qty − promises; FIFO by priority_seq /
   created_date); wire into picking re-allocate, allocateAll, manual
   add/remove cap; summary `skippedInternalTransferSources`.
3. `syncTransferPutAwayTask` helper: create/delete the put_away_tasks row
   as promises change; call it from every allocation mutation touching the
   transfer's items.
4. `internalTransferPicking.ts`: finish fan-out per distinct promised
   picking order (materialize at the order's pair, consume packages,
   post-commit per-order re-allocation, remainder-only put-away task);
   drop order-level link reads; keep shelve flow for the remainder.
5. `internalTransfer.ts` + `routes/admin/internalTransferOrders.ts`:
   remove order-level assign endpoint + link fields; detail exposes
   per-item promised qty/orders.
6. Stock search + availability dialog supply rows (backend queries).

## Admin UI

7. `pages/internal-transfer-orders/[id].vue`: remove link UI; show
   per-item promised info. Picking admin detail: render transfer-source
   allocation rows.

## PDA

8. `pages/internal-transfer/[id].vue`: finish toast reflects fan-out;
   picking scan page unchanged.

## Verification & wrap-up

9. Backend tests: supply pool gating (confirm gate, netting), pair
   resolution via receivingSubInventoryRules/po_no, re-allocate picks
   transfer supply, manual pin/remove drives put-away task create/delete,
   finish fan-out (all promised → no task; mixed → remainder task;
   per-order re-allocation), stock-search rows.
10. `pnpm --filter @warehouse/backend test` + build; `pnpm --filter
    @warehouse/pda test` + `nuxt prepare`; manual pass with
    `pnpm dev:backend` + dev servers.
11. Docs + UAT: `docs/backend/allocation.md`, `flow-config.md`,
    `docs/app-docs/flows/internal-transfer/*`, `ai/feature-registry.md`,
    `ai/code-map.md`, addenda to the two 2026-11-10 specs,
    `docs/uat/functions.json` (ADM-040 + related rows). Commit.
