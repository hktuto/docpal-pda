# Internal Transfer — Stage 2: PDA Transfer Picking + Finish Branches

Date: 2026-11-10
Status: proposed (awaiting stakeholder OK on the forks at the end)
Relation: stage 1 of the same flow shipped in
`2026-11-10-internal-transfer-admin-allocate-design.md` (admin Re-allocate,
delegated picking order link, shared-pool netting). This stage activates the
statuses, the PDA queue + picking, and the two finish branches the
2026-09-28 schema already anticipated (`internal_transfer_packages`,
`put_away_tasks.internal_transfer_order_id`).

## Requirement (stakeholder)

When an internal transfer order comes in, an admin allocates it from `from_`
stock and either links a delegated picking order or leaves it unlinked
(stage 1, shipped). Stage 2: a PDA operator picks the reserved stock off the
`from_` shelves, and on finish the stock lands at the `to_` partition —
feeding the delegated picking order's allocation (cross-dock) or going
through put-away onto a shelf there.

## Lifecycle (statuses activate)

`pending → allocated` is an **explicit admin confirm** (a Confirm button on
the admin detail + `PATCH /admin/internal-transfer-orders/:id/status`, the
flowEdits override pattern) — stage 1 deliberately never wrote status; this
is the gate. The PDA queue lists `allocated` / `picking` / `issue` only
(mirrors picking: unconfirmed transfers stay admin-only). `picking` is set
by the first pick scan (or work-lock claim); `issue` by shortage reporting;
`finished` by the explicit Finish.

Status override semantics (admin, simplified from
`overridePickingOrderStatus`): **`pending` ↔ `allocated` only** (Confirm /
Unconfirm) plus stealing a live work lock — `finished` is a physical-world
fact recorded by the PDA Finish, never an admin keystroke, and `issue` is
set by shortage reporting. Unconfirm schedules no recompute (manual-only
rule). `shortcut: no admin override into finished/issue — add if admins
ever need to force-close a transfer; releasing allocations on such a close
needs its own stock-vs-bookkeeping decision.`

## PDA flow

1. **Queue** — home tile gated by the existing `internal-transfer` flow step
   (backend default on; add the key to the PDA `FlowStep` union + tile).
   List of confirmed orders (allocated/picking/issue) newest-first with
   per-order item/picked progress. `shortcut: no assignee column on
   internal_transfer_orders (upstream-managed table) — the queue is
   operator-visible to all; add the column + task-assignment wiring if
   routing becomes necessary.` Work lock (10-min TTL) via
   `POST/DELETE /internal-transfer-orders/:id/work-lock`, mirroring picking.
2. **Detail** — item lines with their allocation rows as **pick guidance**
   (shelf / box / date-code per reserved source, the same source labels the
   admin table shows), picked progress (`picked_qty`), scan input, package
   list, Finish button. Reuse the picking detail's composables
   (`useLabelScan`, `useHardwareScanner`, `useOrderScanNav` wedge plumbing)
   and the label-decode fallback path.
3. **Pick scan** — `POST /internal-transfer-orders/:id/scan`:
   - capped at the item's allocation rows exactly like picking (2026-10-20
     rule): `reduceTransferAllocation` shrinks the
     `internal_transfer_allocations` row in the same tx; no recompute is
     scheduled;
   - writes one `internal_transfer_packages` row (source_type / source_id /
     qty + lot snapshot date_code / lot_code / coo / cow + scanned fields,
     `shelf_code` NULL — the destination shelf is stamped at put-away);
   - ledger mirrors the picking scan pair: `PICK` rows `reserved −qty` and
     `on_hand −qty` on the `from_` lot, on-hand decremented in the same tx;
   - `recomputeTransferItem` (picked from packages, `status = picked` at
     cover), supplier outdated-scan check reused, `transaction_logs`
     (`entityType: "internal_transfer_order"`), SSE.
   - `pickingShelfScan` flow config applies to transfer picking with the
     same modes (`off` | `require-match` — the shelf-presence check
     pattern at `routes/picking.ts:152`).
   - Package removal (`DELETE …/packages/:packageId`) mirrors picking's:
     restores the lot + allocation, un-picks.
4. **Issue reporting** — the `issue_*` columns exist on the order; reuse the
   picking ReportIssueModal pattern (reason / qty / note), status → `issue`.
   Picking continues; finish requires coverage or a reported issue.
5. **Finish** — explicit button, guarded like picking's (every item covered
   or issue-reported; 409 otherwise), one tx:
   - status → `finished`, work lock released;
   - **Linked branch (delegated picking order set):** the picked packages are
     materialized as **unshelved `inventory_lots` at the delegated order's
     own `(org, sub_inventory_code)` pair** — org already equals `to_org`
     (stage 1's link rule), and the delegated order's pair (not the
     transfer's mostly-NULL `to_sub`, 99.7% of upstream rows) is what its
     demand matches on, so the re-run below can actually reserve the stock —
     merged by the natural lot key (part + date_code + lot_code + coo/cow +
     org/sub, `shelf_code` NULL), `total_qty += qty`, `ADJUST on_hand +qty`
     ledger rows (`txnReason: "internal transfer: arrive"`). Unshelved lots
     are engine-visible (the engine's shelf guard only excludes lots whose
     shelf_code points at a missing shelf). **Finish then awaits
     `allocateForPickingOrder(delegated)`, the confirm-arrival precedent**
     (new stock becomes allocatable → awaited scoped recompute; the one
     sanctioned exception to manual-only). SSE on `/internal-transfer-orders`
     + `/picking-orders`; the PDA offers "open related picking order"
     (2026-09-28 §6).
   - **Unlinked branch:** one `put_away_tasks` row is created
     (`internal_transfer_order_id`, org/sub = the `to_` pair; unique index
     and CHECK already exist). The picked stock stays as packages
     (physically at the staging area) until put-away. `shortcut: unlinked
     lots keep the to_ pair verbatim — a NULL to_sub makes them visible only
     to org-agnostic / share-matched demand; stamp a sub (flow-config rule
     or operator pick) if that ever bites.`

## Put-away branch (unlinked) — native transfer shelving

Receiving's put-away flow is built around `shelf_box_items` keyed on
`receiving_invoice_item_id` (staging boxes, verification flags, auto-clear) —
extending it to transfers means schema surgery on a fragile daily-use flow.
Transfer packages instead already carry verified lot snapshots (they were
picked off our own shelves), so the unlinked branch gets a **native,
lightweight shelving step on the transfer itself**:

- At finish, one `put_away_tasks` row is created (`internal_transfer_order_id`,
  org/sub = the `to_` pair; unique index + CHECK already exist) — the admin
  put-away view sees pending work.
- The transfer queue lists finished orders with unshelved packages
  (`shelf_code IS NULL`) as **put-away pending**; the detail page switches to
  put-away mode: unshelved packages grouped by part + lot snapshot, a part
  scan selects what to shelve, a shelf scan commits.
- `POST /internal-transfer-orders/:id/shelve {partNo, qty?, dateCode?, shelfCode}`
  consumes unshelved packages FIFO, merges/creates the lot at
  (to_org, to_sub, **shelfCode**) with the package's snapshot — the
  re-stamping "shelf → shelf" move — writes `PUT_AWAY on_hand +qty` ledger
  rows, stamps `internal_transfer_packages.shelf_code`; when nothing unshelved
  remains the task flips to `completed`.
- `shortcut: no shelf_box_items rows for transfer shelving (no box
  verification cycle — the stock was verified at its origin shelf); add if
  transfer shelving ever needs the box/verify machinery.`

Both branches end with the stock at `to_`; the difference is only who
shelves it — the delegated order's picker takes it from staging (unshelved)
or an operator shelves it scan-by-scan.

## API surface

| Route | Purpose |
|---|---|
| `GET /internal-transfer-orders` / `/:id` | PDA queue (pickable + put-away-pending) + detail (allocations as pick guidance, packages) |
| `POST`/`DELETE /internal-transfer-orders/:id/work-lock` | 10-min work lock (mirror picking) |
| `POST /internal-transfer-items/:id/scan` | pick scan (allocation-capped, package + PICK ledger pair) |
| `DELETE /internal-transfer-packages/:packageId` | un-pick one package |
| `POST /internal-transfer-orders/:id/report-issue` | shortage report (issue_* columns) |
| `POST /internal-transfer-orders/:id/finish` | branch: materialize at `to_` + delegated re-allocate, or put-away task |
| `POST /internal-transfer-orders/:id/shelve` | put-away branch: shelve unshelved packages onto a scanned shelf |
| `PATCH /admin/internal-transfer-orders/:id/status` | admin confirm / unconfirm (`pending` ↔ `allocated`) + work-lock steal |

## Schema changes

**None required.** `internal_transfer_packages` (incl. `shelf_code` = destination
shelf) and `put_away_tasks.internal_transfer_order_id` exist since migration
0017; the put-away branch needs no new item table (packages are the items).
Optional later: `assignee` on `internal_transfer_orders` (see shortcut).

## PDA app work

`pages/internal-transfer/{index,[id]}.vue` + home tile + `FlowStep` union
key + i18n ×3; queue/detail modeled on the picking pages; put-away pages
grow the transfer branch. `docs/app-docs` internal-transfer flow docs
extend from stage-1 admin-only to the operator flow.

## Tests (new `internalTransferPicking.test.ts` + put-away branch tests)

1. Confirm gate: unconfirmed orders stay out of the queue; Confirm →
   `allocated` + queue-visible; Unconfirm returns to `pending`.
2. Pick scan: capped at allocation (over-scan 409), package row + PICK
   ledger pair + `from_` lot on-hand/reserved deltas, item picked at cover,
   work-lock guard, shelf-scan require-match mode.
3. Package removal restores lot + allocation.
4. Finish linked: unshelved lots materialize at `to_` with correct merge;
   the delegated order's allocation draws them (the awaited re-run); SSE.
5. Finish unlinked: put-away task created once (unique); shelve consumes
   packages FIFO, merges the lot at `to_` + scanned shelf, stamps the
   package, PUT_AWAY ledger, task completes at the last package.
6. Confirm/unconfirm override: work-lock steal on confirm, no recompute.

## Forks needing the stakeholder (my leanings marked)

1. **Delegated allocation at finish** — auto (awaited scoped re-run, the
   confirm-arrival precedent) **[recommended]** vs. manual (admin presses
   Re-allocate on the picking order later).
2. **The confirm gate** — explicit admin Confirm button **[recommended]**
   vs. auto-setting `allocated` when Re-allocate fully covers.
3. **Assignee routing on the transfer queue** — defer **[recommended]** vs.
   add an `assignee` column now (migration on an upstream-managed table +
   task-assignment wiring).
4. **`pickingShelfScan` config** — shared with picking **[recommended]** vs
   a transfer-specific knob.
5. **Issue reporting in v1** — include basic (columns exist) vs. defer.

Carried from stage 1 (should be settled before pick math goes live): the
upstream `qty` magnitude sanity (~64k avg/line), and the sync-writer
agreement that our columns (`picking_order_id`, `allocation_status`,
`allocated_qty`, and now `picked_qty`/`status`) are never clobbered.

## Ceilings / deferred

- No shipping concepts for transfer packages (no boxes / measuring /
  verify — transfers never ship).
- No cross-org transfer picking (sources are `from_`-partition by
  construction).
- Transfer demand still excluded from `part-demand`; dock pre-passes and
  cross-table steal remain off (stage-1 ceilings).
