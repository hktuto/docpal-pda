# Internal Transfer — Admin Allocation + Delegated Picking Order (Stage 1)

Date: 2026-11-10
Status: proposed (awaiting stakeholder OK)
Relation: implements the first two "Later stages" bullets of
`2026-09-28-internal-transfer-order-design.md` (allocation engine merge, admin
UI), adapted to the manual-only allocation world (`2026-11-03`) and the
single-order Re-allocate model (`2026-11-05`). PDA transfer picking + finish
branches (put-away task / feed the delegated order) remain stage 2.

## Requirement (stakeholder, 2026-11-10)

An internal transfer order is both a **demand** and a **supply**:

- **Demand:** upstream syncs the order `pending`; nothing happens until an
  admin runs it. Admin allocates it from our supply — shelved stock
  (`inventory_lots`) or in-hand receiving dock stock — *restricted to the
  order's `from_` partition*, with manual add/remove/search like the picking
  order detail.
- **Supply:** admin may assign a **delegated picking order**
  (`internal_transfer_orders.picking_order_id`). When the transfer is picked
  and finishes (stage 2), the stock lands at the `to_` partition and that
  picking order's allocation can draw it. Unassigned = the put-away branch
  (finish creates a `put_away_tasks` row via the existing
  `internal_transfer_order_id` column — stage 2).

Constraint (stakeholder rule): the assigned picking order's org must match the
transfer's `to_org_id`. Data note: `to_org_id` is always set, but
`to_sub_inventory_code` is NULL for 10,380/10,412 synced orders — so the org is
the enforced gate; sub-inventory compatibility is left to the engine's pair /
share-group matching when the stock actually lands (stage 2).

## Scope

**No schema changes** — all tables exist (migration 0017: orders, items,
`internal_transfer_allocations` mirror of `allocations`, packages,
`put_away_tasks.internal_transfer_order_id`).

In scope (stage 1, admin only):

1. `allocateForInternalTransferOrder` — order-scoped wipe/rebuild engine core.
2. Cross-engine netting: transfer reservations count against picking-side
   availability and vice versa (the shared-pool invariant).
3. Delegated picking order assign/clear endpoint with validation.
4. Manual allocation add/remove for transfer items.
5. Admin detail page: Re-allocate button, assignment picker, allocations table,
   availability modal in transfer mode.
6. Visibility: transfer rows in `GET /admin/part-allocations`.

Out of scope (stage 2 or ceilings, listed at the end): PDA transfer picking,
packages, finish branches, status confirm/override, dock pre-passes,
cross-table steal, part-demand inclusion.

## Engine: `allocateForInternalTransferOrder`

New domain module `apps/backend/src/db/internalTransferAllocate.ts`, mirroring
`allocateForPickingOrder`'s mechanics (same wipe/rebuild invariants — the
`allocate.ts` header comment's "keep in sync" rule applies to this mirror too).

- **Guards** (inside the tx, `FOR UPDATE` on the order row, mirroring the
  2026-11-06 audit #12 pattern): 404 `transfer_order_not_found`; 409
  `order_not_open` unless status `pending`/`allocated`/`picking`
  (`allocated`/`picking` are stage-2 states — included now so the repair path
  exists); 409 `lock_held` when `working_by`/`working_at` is live (10-min TTL,
  same as picking; always free in stage 1).
- **Demand:** the order's items only (no status clause — explicit repair path,
  mirroring picking's order-only scope). Open qty = `qty −
  Σ internal_transfer_packages` (packages are stage 2; currently always 0).
  Part key = `internal_transfer_items.part_no`, matched against source
  `part_no` OR `wcl_item_no` — same rule as the picking engine.
- **Location:** sources restricted to the order's `from_org_id` +
  `from_sub_inventory_code` pair, run through the tn conversion first via
  `transferFromScope` (2026-11-11 amendment — upstream syncs foreign ERP
  offices into `from_org_id`, e.g. 143/STORE1 while the stock physically sits
  in another org's partition): when a `pickingFromSubinventoryOrgs` group
  lists `from_sub_inventory_code` AND that group's org differs from the
  synced one, re-scope to the group's org with the sub resolved by the
  receiving rules over the order's `order_no` / `additional_data.po_no`
  (same `resolveFromSubinventoryLocation` core the picking side uses).
  An already-local pair (group org == `from_org_id`) and unlisted codes stay
  raw. Matching semantics unchanged: case-insensitive code compare,
  `sub_inventory_share_members` widening, NULL pair = org-agnostic.
- **Sources, in order:** shelf lots FIFO by date code (reuse `loadLotSources`,
  exported from `allocate.ts`, with a synthesized `DemandRow` carrying the
  `from_` pair), then dock stock FIFO when `allowDockStock()` — via a
  transfer-local `loadTransferReceivingSources` that nets BOTH allocation
  tables (see netting below) and excludes the target order's own rows (they
  are being wiped).
- **Wipe/rebuild:** delete non-manual `internal_transfer_allocations` rows of
  the order's items + RESERVE-release ledger rows; apply negative lot
  `allocated_qty` deltas up front (source queries must see net availability);
  rebuild FIFO; manual pins survive and are pre-subtracted from demand;
  positive deltas + RESERVE ledger rows at the end; update
  `internal_transfer_items.allocated_qty` (0 for uncovered items).
- **No dock pre-passes** (PO match / qty perfect match). `shortcut: no dock
  pre-passes for transfer runs — admins pin manually for PO-matched cases;
  revisit when transfer picking (stage 2) makes dock sourcing common.`
- **`allocation_status`** refresh for `internal_transfer_orders` (own small
  variant of `refreshAllocationStatus`, window `pending`/`allocated`/
  `picking`, same unallocated/partial/allocated rule).
- **Order status is untouched in stage 1.** `allocation_status` carries the
  state; the `pending → allocated` confirm (and any override) arrives with the
  stage-2 PDA gate, mirroring how picking's `allocated` status is a separate
  admin confirm. Alternative considered and rejected: auto-setting
  `allocated` on full allocation — it would bake a confirm semantics in before
  the PDA stage defines what "confirmed" gates.
- **Ledger / audit:** `inventory_transactions` RESERVE rows with
  `referenceType: "internal_transfer_allocation"`, `txnReason`
  `"recompute: reserve"` / `"recompute: release"`; `transaction_logs` via
  `logTransition` with `entityType: "internal_transfer_order"`; actor from the
  JWT (`actorFrom(c)`), never the body.
- **SSE:** `allocation.computed` (change-gated, multiset compare) and
  `allocation.finished` on topic `/internal-transfer-orders`; catalog entries
  added.

## Cross-engine netting (the shared-pool invariant)

A reservation is a reservation whichever table it sits in. Every availability
path must net BOTH `allocations` (picking) and `internal_transfer_allocations`
(transfer), or the two engines double-book the same stock. Touch points:

1. `allocate.ts` `loadReceivingSources` — the `locked_ii` / `locked_ro`
   netting subqueries each gain a `UNION ALL` branch over
   `internal_transfer_allocations` joined to
   `internal_transfer_orders` for the same per-scope rule (part-key scope nets
   manual + live-work-locked transfer rows; `netAllRemaining` order-scope nets
   all transfer rows). Lot sources need no change — lot availability is
   counter-based (`total_qty − allocated_qty`) and the transfer engine
   maintains the same counter.
2. `picking.ts` `recomputeLot` — currently `Σ allocations` only; becomes
   `Σ allocations + Σ internal_transfer_allocations` per lot. Without this,
   any picking-side manual action on a lot also held by a transfer wipes the
   transfer's contribution from the counter (double-booking).
3. `routes/admin/partAvailability.ts` `GET /part-availability` — the receiving
   rows' `allocatedQty` subquery gains the same union (stock rows use the lot
   counter — automatic).
4. `allocate.ts` `addManualPickingAllocation` — its source-availability cap
   must net transfer rows (same union) or a picking pin can over-book a source
   a transfer holds.
5. `GET /admin/part-allocations` — adds transfer rows (see Visibility below).

The transfer engine's own paths net both tables symmetrically (its own loader
nets all picking rows — they all survive a transfer-scoped wipe — plus other
transfer orders' rows, minus the target order's own rows being wiped).

`stealAllocationsOnSource` (picking manual-add override) stays picking-internal
— it never steals transfer rows. `shortcut: no cross-table steal — an admin
must remove a transfer's allocation to free its stock; revisit if transfer
holdings starve picking overrides.`

## Delegated picking order assignment

`PUT /admin/internal-transfer-orders/:id/picking-order` — body
`{ pickingOrderId: string | null }` (null clears). Domain function in
`src/db/internalTransfer.ts` (first mutation there; tx-wrapped, actorId).

Validation:

- 404 `transfer_order_not_found` / `picking_order_not_found`.
- 409 `transfer_not_editable` when the transfer's status is not
  `pending`/`allocated` (once PDA picking starts the assignment is frozen;
  clearing is equally gated).
- 409 `picking_order_not_open` when the picking order's status is not
  `pending`/`allocated`/`picking`/`issue` (active, pre-shipping; `skip`,
  `cancelled`, `picking_finished`, `measuring_finished`, `shipped` rejected).
- 409 `org_mismatch` when `picking_orders.org_id ≠ to_org_id` (enforced only
  when `to_org_id` is set — always in practice). `to_sub_inventory_code` is
  deliberately NOT enforced (99.7% NULL; see Requirement).

Semantics: 1 transfer → 1 picking order (the column is singular); several
transfers may point at the same picking order. Assignment does not touch
allocations, stock, or the picking order — it is a disposition marker consumed
by stage 2's finish branch. Ledger: `transaction_logs` `logTransition`
(`action: "assign_picking_order"` / `"clear_picking_order"`). SSE: new event
type `internal-transfer.updated` on `/internal-transfer-orders` (catalog
entry). Delta vs the 2026-09-28 spec: no `to_` defaulting from the picking
order — upstream always sets `to_org_id`; we validate instead.

**Sync note:** `internal_transfer_orders` / `_items` rows are upstream-synced;
our writes (`picking_order_id`, `allocation_status`, `allocated_qty`) ride in
the same rows. The sync writer must treat these columns as ours
(insert-only / never clobber) — same practice as `picking_items.allocated_qty`,
which the engine already writes on synced rows. Flag to the sync service.

## Manual allocation actions (transfer items)

Mirror the picking actions, transfer tables:

- `POST /admin/internal-transfer-orders/:id/items/:itemId/allocations` —
  `{ qty, inventoryLotId? | receivingInvoiceItemId? }` →
  `addManualInternalTransferAllocation`: `manual = true` row, RESERVE ledger,
  lot counter + item recompute, audit, SSE. Guards: 404s (order/item/source),
  409 `lock_held`, 409 `shelf_not_found`, 400 `invalid_qty`/`source_required`,
  409 `over_allocation` (Σ allocations > open qty), 409
  `insufficient_available` (source availability nets BOTH allocation tables).
  No location enforcement — admins may override the `from_` pairing, same
  freedom as the picking modal (the modal filters to `from_`, the API trusts
  the admin). No override-steal (ceiling above).
- `DELETE /admin/internal-transfer-orders/:id/items/:itemId/allocations/
  :allocationId` → `removeInternalTransferAllocation`: delete + release
  ledger + recomputes + audit + SSE, no status check, work-lock guard —
  mirrors `removePickingAllocation` exactly. Removal is transient (the next
  Re-allocate may re-create it).

## Visibility

`GET /admin/part-allocations` adds transfer rows: same source columns, plus a
`demandType: "internal-transfer"` discriminator (picking rows get
`"picking"`) and the transfer's `transferOrderId`/`orderNo`/`orderStatus`/work
lock. `AllocationBreakdown.vue` renders them read-mostly (remove works; the
cross-order *transfer* action is picking-only). `shortcut: part-demand
excludes transfer demand — the receiving allocate modal won't list transfers
as competing demand; add when stage 2 makes transfer picking visible.`

`GET /admin/internal-transfer-orders/:id` (existing) extends its payload:
items embed their allocation rows (source type, lot shelf/date code/lot
snapshot, receiving order batch/box, qty, manual) and the order embeds the
assigned picking order summary (`orderNo`, `customerCode`, `status`,
`orgId`). The list endpoint adds `linked` (`picking_order_id IS NOT NULL`).

## API surface (all under `/admin/internal-transfer-orders`)

| Route | Purpose |
|---|---|
| `POST /:id/reallocate` | order-scoped wipe/rebuild (guards above) |
| `PUT /:id/picking-order` | assign/clear delegated picking order |
| `POST /:id/items/:itemId/allocations` | manual pin (availability modal) |
| `DELETE /:id/items/:itemId/allocations/:allocationId` | manual remove |
| `GET /:id` (existing) | + item allocations, picking order summary |

## Admin UI

`apps/admin/pages/internal-transfer-orders/[id].vue` (currently a read-only
header + items — 102 lines):

- **Header actions:** Re-allocate button (visible while status
  `pending`/`allocated`/`picking`; confirm dialog; result toast; disabled with
  holder name on `lock_held` — the picking detail's button is the pattern).
- **Delegated picking order card:** current assignment (or "unassigned →
  put-away on finish"), searchable picker of open picking orders
  (`PickingOrderSearchInput.vue` / the replacement-invoice picker pattern,
  extended with an org filter = `to_org_id` + open statuses), Set/Change/Clear.
- **Items table:** per-item `allocatedQty`, expandable allocation rows with
  source detail and per-row Remove, and the 🔍 availability action opening
  `PartAvailabilityModal.vue` in a transfer mode (target =
  `addManualInternalTransferAllocation`; context pair = the order's `from_`;
  the modal gets a target-mode prop if its shape allows, else a thin
  `TransferAvailabilityModal` variant reusing its tables).
  2026-11-11 amendment: delivered as `TransferAllocateModal.vue`; it passes
  `transferItemId` to `GET /admin/part-availability` (like the picking modal's
  `pickingItemId`), so the dialog context is the tn-CONVERTED source partition
  resolved server-side and the header shows that resolved pair.
- `flowApi.ts` types + methods; i18n keys ×3 locales; list page gains the
  `linked` badge (one column, no new filters).

## Tests (`apps/backend/src/db/internalTransferAllocate.test.ts` + route tests)

1. Re-allocate happy path: shelf FIFO from the `from_` partition only — stock
   in another org / non-shared sub-inventory is never used.
2. Dock sourcing + `allowDockStock=false` skips dock.
3. Netting both ways: (a) a picking allocation on the same lot/receiving item
   reduces transfer availability; (b) a transfer allocation reduces picking
   availability (`allocateForPickingOrder` cannot double-book).
4. `recomputeLot` union: after a picking-side remove on a lot a transfer also
   holds, the lot counter still carries the transfer's qty.
5. Manual pin survives wipe/rebuild; uncovered items get `allocated_qty = 0`;
   `allocation_status` transitions; order status untouched.
6. Manual add/remove guards: `over_allocation`, `insufficient_available`
   netting both tables, ledger + counter assertions.
7. Assignment: happy path, `org_mismatch`, `picking_order_not_open` (e.g.
   `shipped`), `transfer_not_editable`, clear, audit row.
8. `part-allocations` returns transfer rows with `demandType`.

Existing picking allocation tests must stay green (the netting unions).

## Docs / bookkeeping

`docs/backend/api-design.md` (routes), `docs/backend/allocation.md` (transfer
engine section + the both-tables netting invariant), `docs/backend/
event-catalog.md` (`internal-transfer.updated`, transfer-topic allocation
events), `docs/app-docs/flows/internal-transfer/` (minimal overview/steps/
ai-scope) + `feature-registry.md` + `code-map.md`, `docs/uat/functions.json`
(one `ADM-` entry for list + detail + allocate/assign; includes the page added
2026-11-09 without an entry — known omission) + `gen-uat-xlsx.mjs` regen.

## Ceilings / deferred (all deliberate)

- No PDA stage (queue, picking, packages, finish branches, put-away task
  creation) — stage 2; the schema and this stage's guards already anticipate
  the statuses/work locks.
- No dock pre-passes (PO/perfect-match pinning) in transfer runs.
- No cross-table steal in either manual-add override.
- No transfer status confirm/override endpoint.
- `part-demand` excludes transfer demand.
- The admin transfer list is not `allowedOrgIds`-scoped (picking lists are);
  revisit if multi-org visibility rules tighten.
- Upstream `qty` magnitude sanity (22.5k items ≈ 1.45B qty, avg ~64k/line) —
  confirmed acceptable with the stakeholder before the engine work, or flagged
  in UAT if the numbers surprise in practice.
