# Allocation dock-match ordering — implementation plan

Spec: `docs/superpowers/specs/2026-11-05-allocation-dock-match-ordering-design.md`

## 1. `apps/backend/src/db/allocate.ts`

**Data loading**
- `DemandRow`: add `orderPoNo: string | null`; `loadDemands` selects
  `po.po_no AS "orderPoNo"`.
- `ReceivingRow`: add `poNo: string | null`; `loadReceivingSources` selects
  `rii.po_no AS "poNo"`.

**`runScopedAllocation` pre-pass rewrite** (current lines ~1700-1812)
- Keep the `perfect` list build (resolved demands, remaining = openQty −
  manual pins).
- Add shelf-first simulation: per demand in priority order, consume
  `loadLotSources` through a local `Map<lotId, used>` (no writes); store the
  leftover back into `item.remaining` (now = dock remainder).
- Replace `pinPerfectMatch` with a dock-only helper
  `pinDockRows(d, pieces: { qty; recv }[], reason)` — drops the lotId
  branch / lot `allocated_qty` UPDATE, takes the ledger `txnReason` as a
  parameter.
- Pass PO (new, gated by `allowDockStock()`): per demand with
  `remaining > 0`, `demandPo = d.itemPoNo?.trim() || d.orderPoNo?.trim()`;
  filter `loadReceivingSources` rows to allocatable (non-null pair) +
  `poNo?.trim() === demandPo`; take rows in FIFO order up to remaining;
  pin with reason `"recompute: po match"`; `summary.poMatched += 1`.
- Pass A: unchanged grouping, plus gate
  `g.rows.every(r => r.dateCode === oldest)` where
  `oldest = allocatableRows.find(r => r.dateCode !== null)?.dateCode ?? null`
  (computed per demand from its FIFO-ordered rows).
- Pass B: remove the lot branch; single dock row hit requires
  `available === remaining && dateCode === oldest`.
- Rename `perfectPinsCreated` → `prePassPinsCreated` (covers both pin
  kinds); `changed` formula unchanged.

**Summary plumbing**
- `AllocateSummary`: add `poMatched: number` (doc comment: always 0 in
  `allocateAll`); init `poMatched: 0` in both summary literals (allocateAll
  ~line 357, scoped ~line 1575) and in the runner `lastRun` builder
  (~line 2030).

**Comments**
- File-header rules block (~lines 26-36): describe the new ordering
  (shelf FIFO → dock: PO match → gated perfect match → FIFO).
- `allocateAll` divergence comment (~line 633): only dock stock diverges.

## 2. `apps/backend/src/db/allocate.test.ts`

- Replace `"runScopedAllocation: single-row lot match beats a
  higher-priority partial demand"` (line ~509) with a test asserting the
  exact-fit lot is NOT pinned and the split is priority+FIFO
  (`perfectMatched = 0`).
- Extend `insertPickingDemand` with optional `{ poNo, orderPoNo }` writing
  `picking_items.additional_data.po_no` / `picking_orders.po_no`.
- Add tests per spec test plan 3-6 (new part numbers per test to stay
  hermetic; reuse the `setupPerfectMatchWorld` insert pattern).
- Existing group-match test keeps passing (all 4 boxes share dc `2610`).

## 3. Admin type sync

- Skipped: `apps/admin/utils/flowApi.ts` `AllocationRunSummary` does not
  mirror the backend summary (no `perfectMatched` either) and the UI only
  reads `durationMs` — no admin change needed.

## 4. Docs

- `docs/backend/allocation.md`: rewrite the perfect-match paragraph for the
  new ordering + `"recompute: po match"` reason + `poMatched`.
- `AGENTS.md` allocation bullet: update the pre-pass sentence.
- `docs/superpowers/specs/2026-09-22-allocation-perfect-match-design.md`:
  Status line → superseded by the 2026-11-05 spec.
- Check `docs/app-docs/flows/{picking,receiving}/ai-scope.md` for
  perfect-match mentions and update.

## 5. Verify

- `docker compose up -d` (Postgres for tests).
- `pnpm --filter @warehouse/backend test`
- `pnpm --filter @warehouse/backend build`
