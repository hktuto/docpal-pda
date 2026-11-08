import { newId } from "./id.js";
import { inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import { allocations, inventoryTransactions } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";
import { allowDockStock, pickingFromSubinventoryOrgs, receivingSubInventoryRules } from "../config.js";
import { matchSubInventoryRule } from "./receiving.js";
import { logTransition, recomputeLot, recomputePickingItem } from "./picking.js";
import { locationMatches } from "./locationMatch.js";
import { StepTimer } from "./stepTimer.js";

// ---------------------------------------------------------------------------
// Allocation engine (concepts 5-6 in docs/backend/concepts.md).
//
// Demand: open picking items (order status pending/picking) whose order is NOT
// protected by a live work lock (a PDA has the order open — see
// WORK_LOCK_TTL_MINUTES). Open qty = qty − Σ picking_packages (boxed or not —
// scanned-but-unboxed packages must not be re-reserved).
// Sources, in priority order:
//   1. shelf stock (inventory_lots with available_qty > 0)
//   2. in-hand / provisional receiving stock (received, not yet picked) —
//      skipped when FLOW_CONFIG sets picking.allocation.allowDockStock=false
//      (put-away becomes a hard gate; spec 2026-08-10-flow-config-design.md)
// Rules (confirmed with the business):
//   - Order: demands are allocated in picking_orders.priority_seq order
//     (admin-reorderable via POST /picking-orders/reorder).
//   - Source preference (scoped runs only — spec
//     docs/superpowers/specs/2026-11-05-allocation-dock-match-ordering-design.md):
//     shelf lots FIFO first; then dock stock in three ordered passes — PO
//     match (dock rows whose po_no equals the demand's PO are pinned, date
//     code ignored), qty perfect match (an exact-fit whole-receiving-order
//     box group or single dock row, gated to the oldest available dock date
//     code), then dock FIFO. Part-key scoped runs pin matches as MANUAL
//     allocations so they outrank priority_seq and survive every later
//     wipe; order-only scoped runs (admin picking Re-allocate, spec
//     docs/superpowers/specs/2026-11-05-picking-reallocate-single-order-design.md)
//     pin as NON-manual rows of the selected order only. allocateAll
//     runs no pre-pass — pure priority+FIFO.
//   - Location: the picking order's (org_id, sub_inventory_code) pair must
//     match the source's pair — lots match on their own pair, receiving
//     sources on the receiving ITEM's pair (receiving_invoice_items.org_id +
//     sub_inventory_code; order-level partitioning is gone since 2026-08-18).
//     A demand without the pair (both columns NULL) is org-agnostic and
//     matches any source. The code match is widened by
//     sub_inventory_share_members: a source whose sub-inventory shares a
//     share_group with the demand's sub-inventory (same org) also matches.
//     All sub-inventory code comparisons are case-insensitive (upper()):
//     upstream-synced inventory_lots can carry differently-cased codes
//     (e.g. "Store1") than org_info / share members ("STORE1").
//     Transfer orders (spec 2026-09-03-picking-from-subinventory-orgs-design.md):
//     an item carrying additional_data.from_subinventory is a transfer — the
//     order's pair is the DESTINATION, not the source. When a
//     pickingFromSubinventoryOrgs group lists the code, the demand's pair is
//     converted before matching: org_id from the group, sub_inventory_code
//     from the receivingSubInventoryRules evaluated with the item's
//     additional_data.order_no (fallback: additional_data.po_no, else the
//     group default) under the converted org (no receiving-rule match → the
//     from_subinventory code itself). No group match → the order's pair is
//     used as-is.
//   - A receiving item with a NULL pair (org_id or sub_inventory_code) is
//     skipped and counted (AllocateSummary.skippedReceivingSources) — the
//     ingest-time defaulting rule (owner: Sean) is meant to populate it;
//     until then such stock is surfaced, never silently allocated.
//   - Part key: a source matches the demand when either its supplier part_no
//     or its wcl_item_no equals the picking item's part_no — real picking
//     items carry the WCL business key (e.g. "NCC-…") while receiving items /
//     lots store the supplier part number in part_no.
//   - FIFO: oldest date_code first (NULLS LAST). Canonical YYWW lexicographic
//     order is chronological (year pair first), so the plain string ORDER BY
//     is correct across year boundaries (spec
//     2026-10-22-datecode-format-config-design.md).
//   - Box granularity: a receiving line WITH ctn_no allocates down to that box
//     (receiving_invoice_item_id); a line WITHOUT ctn_no allocates to the
//     whole receiving order (receiving_order_id).
// The engine is a full idempotent recompute: existing allocations of an
// unlocked open item are wiped (RESERVE reversal txns) and rebuilt.
// ---------------------------------------------------------------------------

/** A work lock older than this is treated as expired (no cron — compared at recompute/acquire time). */
export const WORK_LOCK_TTL_MINUTES = 10;

export function workLockExpiry(ref: Date = new Date()): Date {
  return new Date(ref.getTime() - WORK_LOCK_TTL_MINUTES * 60_000);
}

export type DateCodeRule = (dateCode: string | null) => boolean;

const YYMM = /(\d{4})/;

function yymm(d: Date): string {
  return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Parse a free-text date-code requirement into a predicate on YYMM date codes.
 * Supported forms:
 *   "2601"                        → exact match
 *   "2601+"                       → date_code >= 2601
 *   "2601-"                       → date_code <= 2601
 *   "within/last/less than N year(s)"  → date_code >= YYMM(N years ago)
 *   "more than N year(s)"              → date_code <  YYMM(N years ago)
 * Returns null when the text carries no recognizable rule (→ plain FIFO).
 *
 * Note: not currently wired into allocateAll — no demand-side date-code rule
 * column remains in the schema (customer_profiles.rule is stored but not yet
 * interpreted). Kept for the future rule interpretation.
 */
export function parseDateCodeRule(text: string | null | undefined, ref: Date = new Date()): DateCodeRule | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();

  const yearsAgo = (n: number) => {
    const d = new Date(Date.UTC(ref.getUTCFullYear() - n, ref.getUTCMonth(), 1));
    return yymm(d);
  };

  const yearMatch = t.match(/(\d+)\s*(?:\+)?\s*years?/);
  if (yearMatch && /(within|last|less than|under|以[内下])/i.test(t)) {
    const threshold = yearsAgo(Number(yearMatch[1]));
    return (dc) => dc !== null && dc >= threshold;
  }
  if (yearMatch && /(more than|over|older than|以上|超过)/i.test(t)) {
    const threshold = yearsAgo(Number(yearMatch[1]));
    return (dc) => dc !== null && dc < threshold;
  }

  const m = t.match(YYMM);
  if (m) {
    const code = m[1];
    if (t.includes("+")) return (dc) => dc !== null && dc >= code;
    if (t.includes("-")) return (dc) => dc !== null && dc <= code;
    return (dc) => dc === code;
  }
  return null;
}

export interface DemandRow {
  pickingItemId: string;
  partNo: string;
  openQty: number;
  customerCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  /** Item-level order no from picking_items.additional_data — first input to
   *  the receiving-rule sub-inventory lookup for transfer items. */
  orderNo: string | null;
  /** Item-level po no from picking_items.additional_data — used when orderNo
   *  is empty; first PO candidate for the dock PO-match pass. */
  itemPoNo: string | null;
  /** Order-level po no (picking_orders.po_no) — fallback PO for the dock
   *  PO-match pass. */
  orderPoNo: string | null;
  /** Transfer marker from upstream (picking_items.additional_data): the
   *  sub-inventory the stock physically comes FROM; the order's own pair is
   *  the destination. */
  fromSubinventory: string | null;
}

interface LotRow {
  lotId: string;
  dateCode: string | null;
  available: number;
}

interface ReceivingRow {
  receivingInvoiceItemId: string;
  receivingOrderId: string;
  ctnNo: string | null;
  dateCode: string | null;
  /** Line-level PO (receiving_invoice_items.po_no) — input to the dock
   *  PO-match pass. */
  poNo: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  available: number;
}

export interface AllocateSummary {
  demands: number;
  fullyAllocated: number;
  partiallyAllocated: number;
  allocationsCreated: number;
  allocationsRemoved: number;
  /** Receiving source rows skipped because the item's location pair is NULL. */
  skippedReceivingSources: number;
  /** Demands that received an exact-fit pinned allocation in the scoped
   *  perfect-match pre-pass (always 0 in allocateAll). */
  perfectMatched: number;
  /** Demands that received a po_no-bound pinned allocation in the scoped
   *  dock PO-match pass (always 0 in allocateAll). */
  poMatched: number;
}

/**
 * Load open demands. Without `onlyOrderId`: every unlocked
 * pending/picking order (allocateAll and the part-key scope). With
 * `onlyOrderId`: ONLY that order's items — no status/work-lock clause, the
 * callers' guards already ran, and an `allocated`-status order's items must
 * be rebuildable (stale-lock repair path). Open qty = qty − Σ
 * picking_packages either way.
 */
async function loadDemands(dbOrTx: DbOrTx, partKeys?: string[], onlyOrderId?: string): Promise<DemandRow[]> {
  return queryAll<DemandRow>(
    dbOrTx,
    sql`SELECT pi.id AS "pickingItemId",
               pi.part_no AS "partNo",
               (pi.qty - COALESCE(pkg.qty, 0)) AS "openQty",
               po.customer_code AS "customerCode",
               po.org_id AS "orgId",
               po.sub_inventory_code AS "subInventoryCode",
               pi.additional_data ->> 'order_no' AS "orderNo",
               pi.additional_data ->> 'po_no' AS "itemPoNo",
               po.po_no AS "orderPoNo",
               pi.additional_data ->> 'from_subinventory' AS "fromSubinventory"
        FROM picking_items pi
        JOIN picking_orders po ON po.id = pi.picking_order_id
        LEFT JOIN (
          SELECT picking_item_id, SUM(qty)::int AS qty
          FROM picking_packages GROUP BY picking_item_id
        ) pkg ON pkg.picking_item_id = pi.id
        WHERE ${onlyOrderId
            ? sql`po.id = ${onlyOrderId}`
            : sql`(po.status IN ('pending', 'picking')
                   AND (po.working_by IS NULL OR po.working_at IS NULL OR po.working_at < ${workLockExpiry()}))`}
          AND pi.qty > COALESCE(pkg.qty, 0)
          ${partKeys && partKeys.length > 0 ? sql`AND ${inArray(sql`pi.part_no`, partKeys)}` : sql``}
        ORDER BY po.priority_seq, po.delivery_date NULLS LAST, po.order_no, pi.id`
  );
}

/**
 * Transfer-order location conversion (FLOW_CONFIG pickingFromSubinventoryOrgs).
 * An item with additional_data.from_subinventory is a transfer: the order's
 * (org_id, sub_inventory_code) is the destination. When a group lists the
 * code, the demand matches stock in the group's orgId, with the sub-inventory
 * resolved by the receivingSubInventoryRules over the item's own reference
 * (same matcher as receiving confirm-arrival): additional_data.order_no when
 * set, else additional_data.po_no, else null (no pattern matches an empty
 * reference, so the group's default applies); when no receiving rule matches,
 * the from_subinventory code itself is used. Items without from_subinventory,
 * or whose code no group lists, keep the order's pair unchanged.
 */
export function resolveDemandLocation(d: DemandRow): DemandRow {
  if (!d.fromSubinventory) return d;
  const groups = pickingFromSubinventoryOrgs();
  if (groups.length === 0) return d;
  const group = groups.find((g) => g.fromSubinventories.includes(d.fromSubinventory!));
  if (!group) return d;
  const ruleRef = d.orderNo?.trim() || d.itemPoNo?.trim() || null;
  return {
    ...d,
    orgId: group.orgId,
    subInventoryCode: matchSubInventoryRule(group.orgId, ruleRef, receivingSubInventoryRules()) ?? d.fromSubinventory,
  };
}

async function loadLotSources(dbOrTx: DbOrTx, d: DemandRow): Promise<LotRow[]> {
  return queryAll<LotRow>(
    dbOrTx,
    sql`SELECT il.id AS "lotId",
               il.date_code AS "dateCode",
               (il.total_qty - il.allocated_qty) AS "available"
        FROM inventory_lots il
        WHERE (il.part_no = ${d.partNo} OR il.wcl_item_no = ${d.partNo})
          AND (${d.orgId}::int IS NULL OR il.org_id = ${d.orgId})
          AND (${d.subInventoryCode}::text IS NULL
               OR upper(il.sub_inventory_code) = upper(${d.subInventoryCode})
               OR EXISTS (SELECT 1 FROM sub_inventory_share_members sm_d
                          JOIN sub_inventory_share_members sm_s ON sm_s.share_group = sm_d.share_group
                          WHERE sm_d.org_id = ${d.orgId} AND upper(sm_d.code) = upper(${d.subInventoryCode})
                            AND sm_s.org_id = il.org_id AND upper(sm_s.code) = upper(il.sub_inventory_code)))
          AND il.total_qty - il.allocated_qty > 0
          -- Upstream sync can write lots whose shelf_code is not in shelves
          -- (replication-role writes bypass the FK); any UPDATE on such a row
          -- then fails the FK check, so exclude them from allocation sources.
          AND (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code))
        ORDER BY il.date_code ASC NULLS LAST, il.id`
  );
}

/**
 * Load in-hand / provisional receiving sources for one demand. Availability
 * must net out allocations that survive the wipe. What survives depends on
 * the scope:
 *   - part-key scope (`netAllRemaining` false): the wipe only touches the
 *     participating (unlocked open) items, so only manual pins and
 *     work-locked orders' rows survive — those are subtracted.
 *   - order-only scope (`netAllRemaining` true, admin picking Re-allocate):
 *     every OTHER order's row survives, so ALL remaining allocation rows
 *     are subtracted — without this the single-order run would double-book
 *     dock stock other orders hold.
 */
async function loadReceivingSources(dbOrTx: DbOrTx, d: DemandRow, netAllRemaining = false): Promise<ReceivingRow[]> {
  const expiry = workLockExpiry();
  return queryAll<ReceivingRow>(
    dbOrTx,
    sql`SELECT rii.id AS "receivingInvoiceItemId",
               ro.id AS "receivingOrderId",
               rii.ctn_no AS "ctnNo",
               rii.date_code AS "dateCode",
               rii.po_no AS "poNo",
               rii.org_id AS "orgId",
               rii.sub_inventory_code AS "subInventoryCode",
               (rii.received_qty - rii.picked_qty
                 - COALESCE(locked_ii.qty, 0) - COALESCE(locked_ro.qty, 0)) AS "available"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        LEFT JOIN (
          SELECT a.receiving_invoice_item_id AS rii_id, SUM(a.qty)::int AS qty
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          WHERE a.receiving_invoice_item_id IS NOT NULL
            ${netAllRemaining
              ? sql``
              : sql`AND (a.manual OR (po.working_by IS NOT NULL AND po.working_at >= ${expiry}))`}
          GROUP BY a.receiving_invoice_item_id
        ) locked_ii ON locked_ii.rii_id = rii.id
        LEFT JOIN (
          SELECT a.receiving_order_id AS ro_id, SUM(a.qty)::int AS qty
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          WHERE a.receiving_order_id IS NOT NULL AND pi.part_no = ${d.partNo}
            ${netAllRemaining
              ? sql``
              : sql`AND (a.manual OR (po.working_by IS NOT NULL AND po.working_at >= ${expiry}))`}
          GROUP BY a.receiving_order_id
        ) locked_ro ON locked_ro.ro_id = ro.id
        WHERE (rii.part_no = ${d.partNo} OR rii.wcl_item_no = ${d.partNo})
          AND ro.status IN ('in_hand', 'provisional_received')
          AND (${d.orgId}::int IS NULL OR rii.org_id = ${d.orgId})
          AND (${d.subInventoryCode}::text IS NULL
               OR upper(rii.sub_inventory_code) = upper(${d.subInventoryCode})
               OR EXISTS (SELECT 1 FROM sub_inventory_share_members sm_d
                          JOIN sub_inventory_share_members sm_s ON sm_s.share_group = sm_d.share_group
                          WHERE sm_d.org_id = ${d.orgId} AND upper(sm_d.code) = upper(${d.subInventoryCode})
                            AND sm_s.org_id = rii.org_id AND upper(sm_s.code) = upper(rii.sub_inventory_code)))
          AND (rii.received_qty - rii.picked_qty
                - COALESCE(locked_ii.qty, 0) - COALESCE(locked_ro.qty, 0)) > 0
        ORDER BY rii.date_code ASC NULLS LAST, rii.id`
  );
}

/**
 * Recompute picking_orders.allocation_status for all open (pending/picking)
 * orders: Σ allocated_qty vs Σ open qty (qty − Σ packages), 'allocated' when
 * equal (incl. the Σ open = 0 fully-picked edge), 'partial' in between. A
 * work-locked order keeps its allocation rows during the recompute, so the
 * aggregate is correct for it too. Runs even when there are no demands (a
 * fully-scanned order has no demand rows but must read 'allocated').
 * last_update_date only bumps where the value actually changes.
 */
export async function refreshAllocationStatus(dbOrTx: DbOrTx): Promise<void> {
  await dbOrTx.execute(sql`
    UPDATE picking_orders po
    SET allocation_status = agg.new_status, last_update_date = now()
    FROM (
      SELECT po2.id,
             CASE
               WHEN COALESCE(SUM(pi.allocated_qty), 0) = COALESCE(SUM(pi.qty), 0) - COALESCE(SUM(pkg.qty), 0) THEN 'allocated'
               WHEN COALESCE(SUM(pi.allocated_qty), 0) > 0 THEN 'partial'
               ELSE 'unallocated'
             END AS new_status
      FROM picking_orders po2
      LEFT JOIN picking_items pi ON pi.picking_order_id = po2.id
      LEFT JOIN (
        SELECT picking_item_id, SUM(qty)::int AS qty
        FROM picking_packages GROUP BY picking_item_id
      ) pkg ON pkg.picking_item_id = pi.id
      WHERE po2.status IN ('pending', 'picking', 'allocated')
      GROUP BY po2.id
    ) agg
    WHERE po.id = agg.id
      AND po.allocation_status IS DISTINCT FROM agg.new_status
  `);
}

/** Full idempotent recompute of allocations for all open picking items. */
export async function allocateAll(db: AppDb): Promise<AllocateSummary> {
  return db.transaction(async (tx) => {
    const summary: AllocateSummary = {
      demands: 0,
      fullyAllocated: 0,
      partiallyAllocated: 0,
      allocationsCreated: 0,
      allocationsRemoved: 0,
      skippedReceivingSources: 0,
      perfectMatched: 0,
      poMatched: 0,
    };
    const demands = await loadDemands(tx);
    summary.demands = demands.length;
    if (demands.length === 0) {
      await refreshAllocationStatus(tx);
      await emitEvent(tx, {
        type: "allocation.finished",
        topics: ["/picking-orders", "/receiving-orders"],
        data: { ...summary, changed: false },
      });
      return summary;
    }

    // Wipe existing allocations of the participating items (+ RESERVE reversals).
    const itemIds = demands.map((d) => d.pickingItemId);
    const existing = await queryAll<{
      id: string;
      pickingItemId: string;
      inventoryLotId: string | null;
      receivingInvoiceItemId: string | null;
      receivingOrderId: string | null;
      qty: number;
      manual: boolean;
      partNo: string;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      shelfCode: string | null;
      /** False when the lot's shelf_code is missing from shelves (upstream
       *  sync wrote it past the FK) — ledger rows must not carry the code. */
      shelfKnown: boolean;
      boxId: string | null;
    }>(
      tx,
      sql`SELECT a.id, a.picking_item_id AS "pickingItemId", a.inventory_lot_id AS "inventoryLotId",
                 a.receiving_invoice_item_id AS "receivingInvoiceItemId",
                 a.receiving_order_id AS "receivingOrderId", a.qty, a.manual,
                 COALESCE(il.part_no, rii.part_no, pi.part_no) AS "partNo",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode",
                 COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS "coo",
                 COALESCE(il.cow, rii.cow) AS "cow",
                 il.shelf_code AS "shelfCode",
                 (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code)) AS "shelfKnown",
                 COALESCE(il.box_id, rii.ctn_no) AS "boxId"
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          WHERE ${inArray(sql`a.picking_item_id`, itemIds)}`
    );
    // Net-change detection for the SSE event: the wipe-and-rebuild counters
    // are non-zero on every run with open demand, so emit only when the
    // allocation set actually changed (multiset compare of canonical keys).
    // Manual (pinned) rows are excluded — they survive the wipe untouched.
    const allocationKey = (
      pickingItemId: string,
      inventoryLotId: string | null,
      receivingInvoiceItemId: string | null,
      receivingOrderId: string | null,
      qty: number
    ) => `${pickingItemId}|${inventoryLotId ?? ""}|${receivingInvoiceItemId ?? ""}|${receivingOrderId ?? ""}|${qty}`;
    const beforeKeys = existing.filter((a) => !a.manual).map((a) =>
      allocationKey(a.pickingItemId, a.inventoryLotId, a.receivingInvoiceItemId, a.receivingOrderId, a.qty)
    );
    const afterKeys: string[] = [];
    const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
    const lotDelta = new Map<string, number>(); // lotId → allocated_qty delta
    // Pinned manual allocations survive the wipe; their qty is pre-subtracted
    // from each item's auto-allocation demand below.
    const manualQtyByItem = new Map<string, number>();

    for (const a of existing) {
      if (a.manual) {
        manualQtyByItem.set(a.pickingItemId, (manualQtyByItem.get(a.pickingItemId) ?? 0) + a.qty);
        continue;
      }
      summary.allocationsRemoved += 1;
      if (a.inventoryLotId) {
        lotDelta.set(a.inventoryLotId, (lotDelta.get(a.inventoryLotId) ?? 0) - a.qty);
      }
      txnRows.push({
        id: newId(),
        inventoryLotId: a.inventoryLotId,
        partNo: a.partNo,
        shelfCode: a.shelfKnown ? a.shelfCode : null,
        boxId: a.boxId,
        txnType: "RESERVE",
        qtyType: "reserved",
        qtyDelta: -a.qty,
        dateCode: a.dateCode,
        lotCode: a.lotCode,
        coo: a.coo,
        cow: a.cow,
        referenceType: "allocation",
        referenceId: a.id,
        receivingInvoiceItemId: a.receivingInvoiceItemId,
        txnReason: "recompute: release",
        txnAt: now(),
      });
    }
    await tx.execute(
      sql`DELETE FROM allocations WHERE ${inArray(sql`picking_item_id`, itemIds)} AND NOT manual`
    );
    // Apply the wipe to lot allocated_qty up front (negative deltas only):
    // the per-demand source queries below must see availability net of the
    // removed reservations — otherwise a priority change makes wiped stock
    // look still-reserved. New allocations accumulate in lotDelta as usual
    // and are applied at the end.
    for (const [lotId, delta] of lotDelta) {
      if (delta === 0) continue;
      await tx.execute(
        sql`UPDATE inventory_lots il SET allocated_qty = allocated_qty + ${delta} WHERE il.id = ${lotId} AND (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code))`
      );
    }
    lotDelta.clear();

    // Rebuild per demand.
    // In-run availability trackers (sources are shared across demands).
    const lotUsed = new Map<string, number>(); // lotId → qty allocated this run
    const recvUsed = new Map<string, number>(); // receiving source key → qty allocated this run

    for (const raw of demands) {
      // Transfer items match stock at the converted source location, never
      // at the order's destination pair.
      const d = resolveDemandLocation(raw);
      // Pinned manual allocations pre-cover part (or all) of the open demand.
      let remaining = Math.max(0, d.openQty - (manualQtyByItem.get(d.pickingItemId) ?? 0));
      const allocatedForItem: { qty: number; lotId?: string; recv?: ReceivingRow }[] = [];

      // 1. shelf stock, FIFO by date_code
      const lots = await loadLotSources(tx, d);
      for (const lot of lots) {
        if (remaining <= 0) break;
        const usable = lot.available - (lotUsed.get(lot.lotId) ?? 0);
        if (usable <= 0) continue;
        const take = Math.min(usable, remaining);
        allocatedForItem.push({ qty: take, lotId: lot.lotId });
        lotUsed.set(lot.lotId, (lotUsed.get(lot.lotId) ?? 0) + take);
        remaining -= take;
      }

      // 2. in-hand / provisional receiving stock, FIFO by date_code —
      // skipped when the warehouse requires put-away before picking
      // (FLOW_CONFIG steps.picking.allocation.allowDockStock=false).
      if (remaining > 0 && allowDockStock()) {
        const rows = await loadReceivingSources(tx, d);
        for (const r of rows) {
          if (remaining <= 0) break;
          // NULL item pair → skip + count (surfaced, never silently allocated)
          if (r.orgId === null || r.subInventoryCode === null) {
            summary.skippedReceivingSources += 1;
            continue;
          }
          // box-level sources track per item; order-level sources pool per order+part
          const key = r.ctnNo ? `item:${r.receivingInvoiceItemId}` : `order:${r.receivingOrderId}:${d.partNo}`;
          const usable = r.available - (recvUsed.get(key) ?? 0);
          if (usable <= 0) continue;
          const take = Math.min(usable, remaining);
          allocatedForItem.push({ qty: take, recv: r });
          recvUsed.set(key, (recvUsed.get(key) ?? 0) + take);
          remaining -= take;
        }
      }

      // Items covered only by pinned manual rows still pass through here so
      // their allocated_qty cache is refreshed (manual + auto).
      if (d.openQty - remaining <= 0) continue;
      if (remaining <= 0) summary.fullyAllocated += 1;
      else summary.partiallyAllocated += 1;

      for (const alloc of allocatedForItem) {
        const id = newId();
        await tx.insert(allocations).values({
          id,
          pickingItemId: d.pickingItemId,
          inventoryLotId: alloc.lotId ?? null,
          receivingInvoiceItemId: alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
          receivingOrderId: alloc.recv && !alloc.recv.ctnNo ? alloc.recv.receivingOrderId : null,
          qty: alloc.qty,
        });
        summary.allocationsCreated += 1;
        afterKeys.push(
          allocationKey(
            d.pickingItemId,
            alloc.lotId ?? null,
            alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
            alloc.recv && !alloc.recv.ctnNo ? alloc.recv.receivingOrderId : null,
            alloc.qty
          )
        );
        if (alloc.lotId) {
          lotDelta.set(alloc.lotId, (lotDelta.get(alloc.lotId) ?? 0) + alloc.qty);
        }
        txnRows.push({
          id: newId(),
          inventoryLotId: alloc.lotId ?? null,
          partNo: d.partNo,
          shelfCode: null,
          boxId: alloc.recv?.ctnNo ?? null,
          txnType: "RESERVE",
          qtyType: "reserved",
          qtyDelta: alloc.qty,
          dateCode: alloc.recv?.dateCode ?? null,
          referenceType: "allocation",
          referenceId: id,
          receivingInvoiceItemId: alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
          txnReason: "recompute: reserve",
          txnAt: now(),
        });
      }
      await tx.execute(
        sql`UPDATE picking_items SET allocated_qty = ${d.openQty - remaining}, last_update_date = ${now()} WHERE id = ${d.pickingItemId}`
      );
    }

    // Apply lot allocated_qty deltas and write the ledger.
    for (const [lotId, delta] of lotDelta) {
      if (delta === 0) continue;
      await tx.execute(
        sql`UPDATE inventory_lots il SET allocated_qty = allocated_qty + ${delta} WHERE il.id = ${lotId} AND (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code))`
      );
    }
    if (txnRows.length > 0) {
      await tx.insert(inventoryTransactions).values(txnRows);
    }
    // Demands with no source leave allocated_qty at 0.
    await tx.execute(
      sql`UPDATE picking_items SET allocated_qty = 0, last_update_date = ${now()}
          WHERE ${inArray(sql`id`, itemIds)} AND id NOT IN (
            SELECT DISTINCT picking_item_id FROM allocations WHERE ${inArray(sql`picking_item_id`, itemIds)}
          )`
    );
    if (summary.skippedReceivingSources > 0) {
      console.warn(
        `allocateAll: skipped ${summary.skippedReceivingSources} receiving source(s) with a NULL item location pair (org_id/sub_inventory_code)`
      );
    }
    const changed = beforeKeys.slice().sort().join("\n") !== afterKeys.slice().sort().join("\n");
    if (changed) {
      await emitEvent(tx, {
        type: "allocation.computed",
        topics: ["/picking-orders"],
        data: { ...summary },
      });
    }
    // Fires on every run (unlike allocation.computed, which is change-gated)
    // so UIs that triggered a recompute can tell the user when it is done.
    await emitEvent(tx, {
      type: "allocation.finished",
      topics: ["/picking-orders", "/receiving-orders"],
      data: { ...summary, changed },
    });
    await refreshAllocationStatus(tx);
    return summary;
  });
}

// ---------------------------------------------------------------------------
// Scoped recompute. Two scopes share runScopedAllocation below:
//   - Part-key scope (allocateForReceivingOrder: after confirm-arrival makes
//     ONE receiving order's stock allocatable — fast enough to await in the
//     request path, so the caller gets the final state immediately).
//     Sources/demands are per-part (a lot / receiving item / picking item
//     each carries one part number, parts never compete), so a recompute
//     scoped to a set of part keys changes provably nothing outside it.
//   - Order-only scope (allocateForPickingOrder: the admin picking "Re-
//     allocate" button — spec
//     docs/superpowers/specs/2026-11-05-picking-reallocate-single-order-design.md).
//     Wipes/rebuilds ONLY the selected order's open items; other orders keep
//     their rows untouched and are netted out of dock availability instead
//     of being rebuilt.
// allocateAll is no longer scheduled by mutation routes — allocation is
// manual-only (spec docs/superpowers/specs/2026-11-03-allocation-manual-only-design.md).
// It remains the dev/test fleet-wide rebuild (`POST /dev/allocate`).
// NOTE: runScopedAllocation mirrors allocateAll's wipe/rebuild mechanics on
// purpose — keep those in sync when the allocation rules change — but
// deliberately diverges with the dock pre-passes (file-header comment);
// allocateAll is the simple priority+FIFO baseline.
// ---------------------------------------------------------------------------

export interface ScopedAllocateResult extends AllocateSummary {
  /** Distinct part keys of the scope (receiving items' part_no + wcl_item_no, or the picking order's item part_nos). */
  partKeys: string[];
  /** Whether the allocation set changed (same multiset compare as allocateAll). */
  changed: boolean;
  durationMs: number;
}

export async function allocateForReceivingOrder(db: AppDb, receivingOrderId: string): Promise<ScopedAllocateResult> {
  const timer = new StepTimer();
  return db.transaction(async (tx) => {
    const keyRows = await timer.measure("loadPartKeys", () =>
      queryAll<{ partKey: string }>(
      tx,
      sql`SELECT DISTINCT k AS "partKey" FROM (
            SELECT rii.part_no AS k
            FROM receiving_invoice_items rii
            JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
            WHERE ri.receiving_order_id = ${receivingOrderId}
            UNION
            SELECT rii.wcl_item_no
            FROM receiving_invoice_items rii
            JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
            WHERE ri.receiving_order_id = ${receivingOrderId}
          ) keys
          WHERE k IS NOT NULL`
      )
    );
    const result = await runScopedAllocation(tx, timer, keyRows.map((r) => r.partKey), { scope: "receiving-order", receivingOrderId });
    console.log(timer.report(`allocateForReceivingOrder ${receivingOrderId}`));
    return result;
  });
}

/**
 * Scoped recompute for ONE picking order (admin picking "Re-allocate",
 * spec docs/superpowers/specs/2026-11-05-picking-reallocate-single-order-design.md):
 * wipe/rebuild ONLY the selected order's open items. Other orders — even
 * ones sharing part numbers — keep their allocation rows untouched; they
 * are netted out of dock availability instead of being rebuilt. 404
 * picking_order_not_found; 409 order_not_open unless pending/picking/
 * allocated; 409 lock_held when a PDA holds the order's work lock (the
 * recompute would run while the operator scans against the rows — the
 * button must not pretend it ran). An `allocated` order is still rebuilt:
 * this is the explicit repair path for a locked order whose rows went
 * stale (demand loading in order-only scope does not filter by status).
 *
 * Accepted trade-off: the run does NOT rebalance other orders' demand.
 * Priority/FIFO convergence across orders requires re-allocating each
 * affected order (fleet-wide: POST /dev/allocate).
 */
export async function allocateForPickingOrder(db: AppDb, pickingOrderId: string): Promise<ScopedAllocateResult> {
  const timer = new StepTimer();
  // The status + work-lock check lives INSIDE the transaction, locking the
  // order row, so a PDA claim can't land between the check and the wipe
  // (audit 2026-11-06 #12). The claim UPDATE in picking.ts locks the same row.
  return db.transaction(async (tx) => {
    const order = await timer.measure("orderLockCheck", () =>
      queryGet<{
      id: string;
      status: string;
      workingBy: string | null;
      workingAt: Date | null;
      holderName: string | null;
    }>(
      tx,
      sql`SELECT po.id, po.status, po.working_by AS "workingBy", po.working_at AS "workingAt",
                 u.display_name AS "holderName"
          FROM picking_orders po
          LEFT JOIN users u ON u.id = po.working_by
          WHERE po.id = ${pickingOrderId}
          FOR UPDATE OF po`
      )
    );
    if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });
    if (order.status !== "pending" && order.status !== "picking" && order.status !== "allocated") {
      throw new HTTPException(409, { message: "order_not_open" });
    }
    if (order.workingBy && order.workingAt && order.workingAt >= workLockExpiry()) {
      throw new HTTPException(409, {
        res: new Response(
          JSON.stringify({ error: "lock_held", holderId: order.workingBy, holderName: order.holderName }),
          { status: 409, headers: { "content-type": "application/json" } }
        ),
      });
    }
    const keyRows = await timer.measure("loadPartKeys", () =>
      queryAll<{ partKey: string }>(
        tx,
        sql`SELECT DISTINCT part_no AS "partKey" FROM picking_items WHERE picking_order_id = ${pickingOrderId}`
      )
    );
    const result = await runScopedAllocation(
      tx,
      timer,
      keyRows.map((r) => r.partKey),
      { scope: "picking-order", pickingOrderId },
      { onlyOrderId: pickingOrderId }
    );
    console.log(timer.report(`allocateForPickingOrder ${pickingOrderId}`));
    return result;
  });
}

export interface RemoveAllocationResult {
  removed: number;
  qty: number;
}

/**
 * Admin "remove allocation": delete ONE allocation row of a picking item
 * (RESERVE-release ledger row, lot/item recomputes, audit log, SSE).
 * 404 picking_order_not_found / picking_item_not_found / allocation_not_found;
 * 409 lock_held when a PDA holds the order's work lock (the PDA's open scan
 * session scans against these rows). No order-status check — admins may fix
 * allocations on orders in any status.
 *
 * The removal is transient — the next allocateAll / scoped recompute may
 * re-allocate the item (deliberate product decision: this is a manual
 * override, not a persistent exclusion).
 */
export async function removePickingAllocation(
  db: AppDb,
  pickingOrderId: string,
  pickingItemId: string,
  allocationId: string,
  actorId: string
): Promise<RemoveAllocationResult> {
  const order = await queryGet<{
    id: string;
    status: string;
    workingBy: string | null;
    workingAt: Date | null;
    holderName: string | null;
  }>(
    db,
    sql`SELECT po.id, po.status, po.working_by AS "workingBy", po.working_at AS "workingAt",
               u.display_name AS "holderName"
        FROM picking_orders po
        LEFT JOIN users u ON u.id = po.working_by
        WHERE po.id = ${pickingOrderId}`
  );
  if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });
  if (order.workingBy && order.workingAt && order.workingAt >= workLockExpiry()) {
    throw new HTTPException(409, {
      res: new Response(
        JSON.stringify({ error: "lock_held", holderId: order.workingBy, holderName: order.holderName }),
        { status: 409, headers: { "content-type": "application/json" } }
      ),
    });
  }

  const item = await queryGet<{ id: string; partNo: string }>(
    db,
    sql`SELECT id, part_no AS "partNo" FROM picking_items WHERE id = ${pickingItemId} AND picking_order_id = ${pickingOrderId}`
  );
  if (!item) throw new HTTPException(404, { message: "picking_item_not_found" });

  return db.transaction(async (tx) => {
    const existing = await queryGet<{
      id: string;
      inventoryLotId: string | null;
      receivingInvoiceItemId: string | null;
      qty: number;
      partNo: string;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      shelfCode: string | null;
      shelfKnown: boolean;
      boxId: string | null;
    }>(
      tx,
      sql`SELECT a.id, a.inventory_lot_id AS "inventoryLotId",
                 a.receiving_invoice_item_id AS "receivingInvoiceItemId", a.qty,
                 COALESCE(il.part_no, rii.part_no, pi.part_no) AS "partNo",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode",
                 COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS "coo",
                 COALESCE(il.cow, rii.cow) AS "cow",
                 il.shelf_code AS "shelfCode",
                 (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code)) AS "shelfKnown",
                 COALESCE(il.box_id, rii.ctn_no) AS "boxId"
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          WHERE a.id = ${allocationId} AND a.picking_item_id = ${pickingItemId}`
    );
    if (!existing) throw new HTTPException(404, { message: "allocation_not_found" });

    await tx.execute(sql`DELETE FROM allocations WHERE id = ${allocationId}`);

    if (existing.inventoryLotId) {
      await recomputeLot(tx, existing.inventoryLotId);
    }
    await recomputePickingItem(tx, pickingItemId);

    await tx.insert(inventoryTransactions).values({
      id: newId(),
      inventoryLotId: existing.inventoryLotId,
      partNo: existing.partNo,
      shelfCode: existing.shelfKnown ? existing.shelfCode : null,
      boxId: existing.boxId,
      txnType: "RESERVE",
      qtyType: "reserved",
      qtyDelta: -existing.qty,
      dateCode: existing.dateCode,
      lotCode: existing.lotCode,
      coo: existing.coo,
      cow: existing.cow,
      referenceType: "allocation",
      referenceId: existing.id,
      receivingInvoiceItemId: existing.receivingInvoiceItemId,
      actorId,
      txnReason: "admin: remove allocation",
      txnAt: now(),
    });

    await refreshAllocationStatus(tx);

    await logTransition(tx, {
      entityType: "picking_order",
      entityId: pickingOrderId,
      fromState: order.status,
      toState: order.status,
      actorId,
      metadata: { action: "remove_allocation", allocationId, itemId: pickingItemId, partNo: item.partNo, qty: existing.qty },
    });

    await emitEvent(tx, {
      type: "allocation.computed",
      topics: ["/picking-orders"],
      data: { scope: "picking-order-item", pickingOrderId, pickingItemId, allocationId, removed: 1, qty: existing.qty },
    });

    return { removed: 1, qty: existing.qty };
  });
}

/**
 * Reclaim `shortfall` qty from OTHER picking items' non-manual allocations on
 * one source (a stock lot or a receiving invoice item), oldest first. Victims
 * whose order holds a live PDA work lock are skipped — the operator's open scan
 * session scans against those rows — and manual pins are never stolen. Each
 * stolen row gets a RESERVE-release ledger row, a `allocation_stolen` audit
 * entry and an `allocation.computed` event on the victim order.
 *
 * With `override: false` any shortfall is refused outright (409
 * `insufficient_available`); the caller decides when overriding is allowed.
 * Throws 409 `insufficient_available` if the shortfall cannot be covered in
 * full, so the caller's transaction rolls back.
 *
 * Shared by the single-row `addManualPickingAllocation` and the batch
 * admin allocate form (`pickingAllocateForm.ts`).
 */
export async function stealAllocationsOnSource(
  tx: DbOrTx,
  input: {
    inventoryLotId: string | null;
    receivingInvoiceItemId: string | null;
    shortfall: number;
    override: boolean;
    thiefOrderId: string;
    thiefItemId: string;
    /** Additional picking items whose rows are never stolen (the grouped
     *  allocate form excludes the whole part group — their holdings on the
     *  source are netted by the form's own distribution). */
    excludeItemIds?: string[];
    actorId: string;
  }
): Promise<void> {
  if (input.shortfall <= 0) return;
  if (!input.override) {
    throw new HTTPException(409, { message: "insufficient_available" });
  }
  const pickingOrderId = input.thiefOrderId;
  const pickingItemId = input.thiefItemId;
  const actorId = input.actorId;
  let shortfall = input.shortfall;
    const victims = await queryAll<{
      id: string;
      qty: number;
      victimItemId: string;
      victimOrderId: string;
      victimOrderStatus: string;
      workingBy: string | null;
      workingAt: Date | null;
      partNo: string;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      shelfCode: string | null;
      shelfKnown: boolean;
      boxId: string | null;
    }>(
      tx,
      sql`SELECT a.id, a.qty,
                 pi.id AS "victimItemId",
                 po.id AS "victimOrderId",
                 po.status AS "victimOrderStatus",
                 po.working_by AS "workingBy",
                 po.working_at AS "workingAt",
                 COALESCE(il.part_no, rii.part_no, pi.part_no) AS "partNo",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode",
                 COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS "coo",
                 COALESCE(il.cow, rii.cow) AS "cow",
                 il.shelf_code AS "shelfCode",
                 (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code)) AS "shelfKnown",
                 COALESCE(il.box_id, rii.ctn_no) AS "boxId"
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          WHERE a.manual = false
            AND a.picking_item_id <> ${pickingItemId}
            ${input.excludeItemIds?.length
              ? sql`AND NOT (a.picking_item_id IN (${sql.join(input.excludeItemIds, sql`, `)}))`
              : sql``}
            AND (a.inventory_lot_id = ${input.inventoryLotId ?? null}
             OR a.receiving_invoice_item_id = ${input.receivingInvoiceItemId ?? null})
          ORDER BY a.created_date ASC`
    );
    for (const v of victims) {
      if (shortfall <= 0) break;
      if (v.qty <= 0) continue;
      if (v.workingBy && v.workingAt && v.workingAt >= workLockExpiry()) continue;
      const take = Math.min(v.qty, shortfall);
      if (take === v.qty) {
        await tx.execute(sql`DELETE FROM allocations WHERE id = ${v.id}`);
      } else {
        await tx.execute(sql`UPDATE allocations SET qty = qty - ${take} WHERE id = ${v.id}`);
      }
      shortfall -= take;

      await tx.insert(inventoryTransactions).values({
        id: newId(),
        inventoryLotId: input.inventoryLotId ?? null,
        partNo: v.partNo,
        shelfCode: v.shelfKnown ? v.shelfCode : null,
        boxId: v.boxId,
        txnType: "RESERVE",
        qtyType: "reserved",
        qtyDelta: -take,
        dateCode: v.dateCode,
        lotCode: v.lotCode,
        coo: v.coo,
        cow: v.cow,
        referenceType: "allocation",
        referenceId: v.id,
        receivingInvoiceItemId: input.receivingInvoiceItemId ?? null,
        actorId,
        txnReason: "admin: override steal",
        txnAt: now(),
      });

      await recomputePickingItem(tx, v.victimItemId);

      await logTransition(tx, {
        entityType: "picking_order",
        entityId: v.victimOrderId,
        fromState: v.victimOrderStatus,
        toState: v.victimOrderStatus,
        actorId,
        metadata: {
          action: "allocation_stolen",
          allocationId: v.id,
          itemId: v.victimItemId,
          partNo: v.partNo,
          qty: take,
          thiefOrderId: pickingOrderId,
          thiefItemId: pickingItemId,
        },
      });

      await emitEvent(tx, {
        type: "allocation.computed",
        topics: ["/picking-orders"],
        data: {
          scope: "picking-order-item",
          pickingOrderId: v.victimOrderId,
          pickingItemId: v.victimItemId,
          allocationId: v.id,
          action: "stolen",
          qty: take,
        },
      });
    }
    if (shortfall > 0) {
      throw new HTTPException(409, { message: "insufficient_available" });
    }
    if (input.inventoryLotId) {
      await recomputeLot(tx, input.inventoryLotId);
    }
}

/**
 * Admin "manual allocation" (availability modal Allocate): pin one allocation
 * row for a picking item against a specific stock lot or receiving invoice
 * item, in ANY location (admins may override the engine's location pairing).
 * Guards: 404 picking_order_not_found / picking_item_not_found /
 * inventory_lot_not_found / receiving_invoice_item_not_found; 409 lock_held
 * (same rationale as remove) / shelf_not_found (the lot's shelf_code is
 * missing from `shelves` — it can't take pins); 400 invalid_qty /
 * source_required; 409 insufficient_available (source can't cover qty) /
 * over_allocation (Σ allocations would exceed the item's open qty = qty − Σ
 * packages). No order-status check, matching the remove action.
 *
 * With `override: true` a qty above the source's availability is allowed: the
 * shortfall is reclaimed inside the same tx from OTHER picking items'
 * non-manual allocations on that source (oldest first; victims whose order
 * holds a live work lock are skipped, manual pins are never stolen). Each
 * stolen row gets a RESERVE-release ledger row, an audit log + SSE event on
 * the VICTIM order. The victim's demand stays uncovered until the next
 * recompute — same semantics as the admin remove-allocation action.
 *
 * The row is created with manual = true: allocateAll / runScopedAllocation
 * preserve pinned rows and only auto-allocate the remaining open demand.
 */
export async function addManualPickingAllocation(
  db: AppDb,
  pickingOrderId: string,
  pickingItemId: string,
  input: { qty: number; inventoryLotId?: string; receivingInvoiceItemId?: string; override?: boolean },
  actorId: string
): Promise<{ allocationId: string; qty: number }> {
  const qty = input.qty;
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new HTTPException(400, { message: "invalid_qty" });
  }
  const hasLot = !!input.inventoryLotId;
  const hasRecv = !!input.receivingInvoiceItemId;
  if (hasLot === hasRecv) {
    throw new HTTPException(400, { message: "source_required" });
  }

  const order = await queryGet<{
    id: string;
    status: string;
    workingBy: string | null;
    workingAt: Date | null;
    holderName: string | null;
  }>(
    db,
    sql`SELECT po.id, po.status, po.working_by AS "workingBy", po.working_at AS "workingAt",
               u.display_name AS "holderName"
        FROM picking_orders po
        LEFT JOIN users u ON u.id = po.working_by
        WHERE po.id = ${pickingOrderId}`
  );
  if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });
  if (order.workingBy && order.workingAt && order.workingAt >= workLockExpiry()) {
    throw new HTTPException(409, {
      res: new Response(
        JSON.stringify({ error: "lock_held", holderId: order.workingBy, holderName: order.holderName }),
        { status: 409, headers: { "content-type": "application/json" } }
      ),
    });
  }

  const item = await queryGet<{ id: string; partNo: string; qty: number }>(
    db,
    sql`SELECT id, part_no AS "partNo", qty FROM picking_items WHERE id = ${pickingItemId} AND picking_order_id = ${pickingOrderId}`
  );
  if (!item) throw new HTTPException(404, { message: "picking_item_not_found" });

  return db.transaction(async (tx) => {
    // Source existence + availability.
    let source: {
      partNo: string;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      shelfCode: string | null;
      boxId: string | null;
      available: number;
    };
    if (hasLot) {
      const lot = await queryGet<{
        id: string;
        partNo: string;
        dateCode: string | null;
        lotCode: string | null;
        coo: string | null;
        cow: string | null;
        shelfCode: string | null;
        boxId: string | null;
        available: number;
        shelfKnown: boolean;
      }>(
        tx,
        sql`SELECT id, part_no AS "partNo", date_code AS "dateCode", lot_code AS "lotCode",
                   coo, cow, shelf_code AS "shelfCode", box_id AS "boxId",
                   (total_qty - allocated_qty) AS "available",
                   (shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = inventory_lots.shelf_code)) AS "shelfKnown"
            FROM inventory_lots WHERE id = ${input.inventoryLotId!}`
      );
      if (!lot) throw new HTTPException(404, { message: "inventory_lot_not_found" });
      // A lot whose shelf_code is missing from shelves (upstream sync wrote it
      // past the FK) can't take pins: the scan-time lot resolution excludes
      // it, and the ledger inserts would violate the shelf FK — same rule as
      // the engine's shelf-FK orphan exclusion.
      if (!lot.shelfKnown) throw new HTTPException(409, { message: "shelf_not_found" });
      source = lot;
    } else {
      const recv = await queryGet<{
        id: string;
        partNo: string;
        dateCode: string | null;
        lotCode: string | null;
        coo: string | null;
        cow: string | null;
        boxId: string | null;
        available: number;
      }>(
        tx,
        sql`SELECT rii.id, rii.part_no AS "partNo", rii.date_code AS "dateCode",
                   rii.lot_code AS "lotCode", rii.coo, rii.cow, rii.ctn_no AS "boxId",
                   (rii.received_qty - rii.picked_qty - COALESCE(alloc.qty, 0)) AS "available"
            FROM receiving_invoice_items rii
            LEFT JOIN (
              SELECT receiving_invoice_item_id, SUM(qty)::int AS qty
              FROM allocations WHERE receiving_invoice_item_id IS NOT NULL
              GROUP BY receiving_invoice_item_id
            ) alloc ON alloc.receiving_invoice_item_id = rii.id
            WHERE rii.id = ${input.receivingInvoiceItemId!}`
      );
      if (!recv) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
      source = { ...recv, shelfCode: null };
    }
    if (qty > source.available) {
      await stealAllocationsOnSource(tx, {
        inventoryLotId: input.inventoryLotId ?? null,
        receivingInvoiceItemId: input.receivingInvoiceItemId ?? null,
        shortfall: qty - source.available,
        override: input.override === true,
        thiefOrderId: pickingOrderId,
        thiefItemId: pickingItemId,
        actorId,
      });
    }

    // Total allocated for the item must not exceed its open qty.
    const open = await queryGet<{ openQty: number; allocated: number }>(
      tx,
      sql`SELECT (pi.qty - COALESCE(pkg.qty, 0)) AS "openQty",
                 COALESCE(alloc.qty, 0) AS "allocated"
          FROM picking_items pi
          LEFT JOIN (
            SELECT picking_item_id, SUM(qty)::int AS qty FROM picking_packages GROUP BY picking_item_id
          ) pkg ON pkg.picking_item_id = pi.id
          LEFT JOIN (
            SELECT picking_item_id, SUM(qty)::int AS qty FROM allocations GROUP BY picking_item_id
          ) alloc ON alloc.picking_item_id = pi.id
          WHERE pi.id = ${pickingItemId}`
    );
    if (open!.allocated + qty > open!.openQty) {
      throw new HTTPException(409, { message: "over_allocation" });
    }

    const allocationId = newId();
    await tx.insert(allocations).values({
      id: allocationId,
      pickingItemId,
      inventoryLotId: input.inventoryLotId ?? null,
      receivingInvoiceItemId: input.receivingInvoiceItemId ?? null,
      receivingOrderId: null,
      qty,
      manual: true,
    });

    if (input.inventoryLotId) {
      await recomputeLot(tx, input.inventoryLotId);
    }
    await recomputePickingItem(tx, pickingItemId);

    await tx.insert(inventoryTransactions).values({
      id: newId(),
      inventoryLotId: input.inventoryLotId ?? null,
      partNo: source.partNo,
      shelfCode: source.shelfCode,
      boxId: source.boxId,
      txnType: "RESERVE",
      qtyType: "reserved",
      qtyDelta: qty,
      dateCode: source.dateCode,
      lotCode: source.lotCode,
      coo: source.coo,
      cow: source.cow,
      referenceType: "allocation",
      referenceId: allocationId,
      receivingInvoiceItemId: input.receivingInvoiceItemId ?? null,
      actorId,
      txnReason: "admin: manual allocation",
      txnAt: now(),
    });

    await refreshAllocationStatus(tx);

    await logTransition(tx, {
      entityType: "picking_order",
      entityId: pickingOrderId,
      fromState: order.status,
      toState: order.status,
      actorId,
      metadata: {
        action: "manual_allocation",
        allocationId,
        itemId: pickingItemId,
        partNo: item.partNo,
        qty,
        inventoryLotId: input.inventoryLotId ?? null,
        receivingInvoiceItemId: input.receivingInvoiceItemId ?? null,
      },
    });

    await emitEvent(tx, {
      type: "allocation.computed",
      topics: ["/picking-orders"],
      data: { scope: "picking-order-item", pickingOrderId, pickingItemId, allocationId, manual: true, qty },
    });

    return { allocationId, qty };
  });
}

export interface TransferAllocationResult {
  pickingItemId: string;
  /** The TARGET allocation row — amended or newly inserted, always manual. */
  allocationId: string;
  qty: number;
}

/**
 * Admin cross-order transfer (spec
 * docs/superpowers/specs/2026-10-14-admin-cross-order-allocation-control-design.md):
 * move `qty` (default: the whole row) from ANOTHER picking item's allocation
 * onto this item as a MANUAL pin, in one transaction. Unlike a bare remove —
 * which returns stock to the pool where the next allocateAll re-grabs it by
 * priority — the transfer pins the qty on the target in the same commit, so
 * the admin's intent survives every later wipe/rebuild.
 *
 * Validation, all before any write: 404 picking_order_not_found /
 * picking_item_not_found / allocation_not_found; 409 same_item (the source
 * row already belongs to the target item); 409 lock_held with holder info on
 * EITHER the source or the target order (a PDA is scanning against those
 * rows); 400 invalid_qty (not a positive integer ≤ the source row's qty);
 * 409 location_mismatch (the source's org/sub-inventory must match the target
 * order's partition under the engine's locationMatches rule, share-group
 * siblings included — a demand without a partition is org-agnostic and
 * matches any source); 409 over_allocation (Σ target allocations on the same
 * source + qty would pass the item's open qty = qty − Σ packages). No
 * order-status check, matching remove / manual-pin. Manual source rows are
 * transferable — the transfer IS an explicit admin decision.
 *
 * Apply: shrink-or-delete the source row with a RESERVE-release ledger row
 * ("admin: transfer out", shelf nulled when missing from shelves — same rule
 * as every release-side ledger write), recomputeLot, recomputePickingItem on
 * the source item and an allocation_transferred_out audit on the source
 * order; amend-or-insert ONE manual row on the target item (one picking item
 * + one source = one allocation line) with a RESERVE ledger row ("admin:
 * transfer in"), recomputePickingItem on the target and an
 * allocation_transferred_in audit on the target order. No scheduleAllocateAll
 * — the source item's residual demand is left for the next engine run, same
 * as the remove action.
 */
export async function transferPickingAllocation(
  db: AppDb,
  pickingOrderId: string,
  pickingItemId: string,
  input: { allocationId: string; qty?: number },
  actorId: string
): Promise<TransferAllocationResult> {
  const order = await queryGet<{
    id: string;
    status: string;
    orgId: number | null;
    subInventoryCode: string | null;
    workingBy: string | null;
    workingAt: Date | null;
    holderName: string | null;
  }>(
    db,
    sql`SELECT po.id, po.status, po.org_id AS "orgId", po.sub_inventory_code AS "subInventoryCode",
               po.working_by AS "workingBy", po.working_at AS "workingAt",
               u.display_name AS "holderName"
        FROM picking_orders po
        LEFT JOIN users u ON u.id = po.working_by
        WHERE po.id = ${pickingOrderId}`
  );
  if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });

  const item = await queryGet<{ id: string; partNo: string }>(
    db,
    sql`SELECT id, part_no AS "partNo" FROM picking_items WHERE id = ${pickingItemId} AND picking_order_id = ${pickingOrderId}`
  );
  if (!item) throw new HTTPException(404, { message: "picking_item_not_found" });

  return db.transaction(async (tx) => {
    const source = await queryGet<{
      id: string;
      sourceItemId: string;
      qty: number;
      manual: boolean;
      inventoryLotId: string | null;
      receivingInvoiceItemId: string | null;
      receivingOrderId: string | null;
      partNo: string;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      shelfCode: string | null;
      shelfKnown: boolean;
      boxId: string | null;
      sourceOrderId: string;
      sourceOrderStatus: string;
      sourceWorkingBy: string | null;
      sourceWorkingAt: Date | null;
      sourceHolderName: string | null;
      locationMatched: boolean;
    }>(
      tx,
      sql`SELECT a.id, a.picking_item_id AS "sourceItemId", a.qty, a.manual,
                 a.inventory_lot_id AS "inventoryLotId",
                 a.receiving_invoice_item_id AS "receivingInvoiceItemId",
                 a.receiving_order_id AS "receivingOrderId",
                 COALESCE(il.part_no, rii.part_no, spi.part_no) AS "partNo",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode",
                 COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS "coo",
                 COALESCE(il.cow, rii.cow) AS "cow",
                 il.shelf_code AS "shelfCode",
                 (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code)) AS "shelfKnown",
                 COALESCE(il.box_id, rii.ctn_no) AS "boxId",
                 spo.id AS "sourceOrderId",
                 spo.status AS "sourceOrderStatus",
                 spo.working_by AS "sourceWorkingBy",
                 spo.working_at AS "sourceWorkingAt",
                 su.display_name AS "sourceHolderName",
                 ${locationMatches(
                   { orgId: order.orgId, subInventoryCode: order.subInventoryCode },
                   sql`COALESCE(il.org_id, rii.org_id)`,
                   sql`COALESCE(il.sub_inventory_code, rii.sub_inventory_code)`
                 )} AS "locationMatched"
          FROM allocations a
          JOIN picking_items spi ON spi.id = a.picking_item_id
          JOIN picking_orders spo ON spo.id = spi.picking_order_id
          LEFT JOIN users su ON su.id = spo.working_by
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          WHERE a.id = ${input.allocationId}`
    );
    if (!source) throw new HTTPException(404, { message: "allocation_not_found" });
    if (source.sourceItemId === pickingItemId) {
      throw new HTTPException(409, { message: "same_item" });
    }
    if (source.sourceWorkingBy && source.sourceWorkingAt && source.sourceWorkingAt >= workLockExpiry()) {
      throw new HTTPException(409, {
        res: new Response(
          JSON.stringify({ error: "lock_held", holderId: source.sourceWorkingBy, holderName: source.sourceHolderName }),
          { status: 409, headers: { "content-type": "application/json" } }
        ),
      });
    }
    if (order.workingBy && order.workingAt && order.workingAt >= workLockExpiry()) {
      throw new HTTPException(409, {
        res: new Response(
          JSON.stringify({ error: "lock_held", holderId: order.workingBy, holderName: order.holderName }),
          { status: 409, headers: { "content-type": "application/json" } }
        ),
      });
    }

    const qty = input.qty ?? source.qty;
    if (!Number.isInteger(qty) || qty <= 0 || qty > source.qty) {
      throw new HTTPException(400, { message: "invalid_qty" });
    }
    if (!source.locationMatched) {
      throw new HTTPException(409, { message: "location_mismatch" });
    }

    // One picking item + one source = one allocation line: amend the target's
    // existing row on this source (if any) rather than inserting a second.
    const srcCond = source.inventoryLotId
      ? sql`inventory_lot_id = ${source.inventoryLotId}`
      : source.receivingInvoiceItemId
        ? sql`receiving_invoice_item_id = ${source.receivingInvoiceItemId}`
        : sql`receiving_order_id = ${source.receivingOrderId}`;
    const targetRow = await queryGet<{ id: string; qty: number }>(
      tx,
      sql`SELECT id, qty FROM allocations
          WHERE picking_item_id = ${pickingItemId} AND ${srcCond}
          ORDER BY manual DESC, created_date ASC
          LIMIT 1`
    );
    const open = await queryGet<{ openQty: number }>(
      tx,
      sql`SELECT (pi.qty - COALESCE(pkg.qty, 0)) AS "openQty"
          FROM picking_items pi
          LEFT JOIN (
            SELECT picking_item_id, SUM(qty)::int AS qty FROM picking_packages GROUP BY picking_item_id
          ) pkg ON pkg.picking_item_id = pi.id
          WHERE pi.id = ${pickingItemId}`
    );
    if ((targetRow?.qty ?? 0) + qty > open!.openQty) {
      throw new HTTPException(409, { message: "over_allocation" });
    }

    // --- source side: shrink-or-delete + release ledger + audit -----------
    if (qty === source.qty) {
      await tx.execute(sql`DELETE FROM allocations WHERE id = ${source.id}`);
    } else {
      await tx.execute(
        sql`UPDATE allocations SET qty = qty - ${qty}, last_update_date = ${now()} WHERE id = ${source.id}`
      );
    }

    // --- target side: amend-or-insert one manual pin ----------------------
    let targetAllocationId: string;
    let targetBefore: number;
    if (targetRow) {
      targetAllocationId = targetRow.id;
      targetBefore = targetRow.qty;
      await tx.execute(
        sql`UPDATE allocations SET qty = qty + ${qty}, manual = true, last_update_date = ${now()}
            WHERE id = ${targetAllocationId}`
      );
    } else {
      targetAllocationId = newId();
      targetBefore = 0;
      await tx.insert(allocations).values({
        id: targetAllocationId,
        pickingItemId,
        inventoryLotId: source.inventoryLotId,
        receivingInvoiceItemId: source.receivingInvoiceItemId,
        receivingOrderId: source.receivingOrderId,
        qty,
        manual: true,
      });
    }

    if (source.inventoryLotId) {
      await recomputeLot(tx, source.inventoryLotId);
    }
    await recomputePickingItem(tx, source.sourceItemId);
    await recomputePickingItem(tx, pickingItemId);

    // Release-side ledger row: never hand an unknown shelf code to the ledger
    // (the shelves FK would roll the whole transfer back).
    await tx.insert(inventoryTransactions).values({
      id: newId(),
      inventoryLotId: source.inventoryLotId,
      partNo: source.partNo,
      shelfCode: source.shelfKnown ? source.shelfCode : null,
      boxId: source.boxId,
      txnType: "RESERVE",
      qtyType: "reserved",
      qtyDelta: -qty,
      dateCode: source.dateCode,
      lotCode: source.lotCode,
      coo: source.coo,
      cow: source.cow,
      referenceType: "allocation",
      referenceId: source.id,
      receivingInvoiceItemId: source.receivingInvoiceItemId,
      actorId,
      txnReason: "admin: transfer out",
      txnAt: now(),
    });
    await tx.insert(inventoryTransactions).values({
      id: newId(),
      inventoryLotId: source.inventoryLotId,
      partNo: source.partNo,
      shelfCode: source.shelfKnown ? source.shelfCode : null,
      boxId: source.boxId,
      txnType: "RESERVE",
      qtyType: "reserved",
      qtyDelta: qty,
      dateCode: source.dateCode,
      lotCode: source.lotCode,
      coo: source.coo,
      cow: source.cow,
      referenceType: "allocation",
      referenceId: targetAllocationId,
      receivingInvoiceItemId: source.receivingInvoiceItemId,
      actorId,
      txnReason: "admin: transfer in",
      txnAt: now(),
    });

    await refreshAllocationStatus(tx);

    await logTransition(tx, {
      entityType: "picking_order",
      entityId: source.sourceOrderId,
      fromState: source.sourceOrderStatus,
      toState: source.sourceOrderStatus,
      actorId,
      metadata: {
        action: "allocation_transferred_out",
        allocationId: source.id,
        itemId: source.sourceItemId,
        partNo: source.partNo,
        qty,
        beforeQty: source.qty,
        afterQty: source.qty - qty,
        targetOrderId: pickingOrderId,
        targetItemId: pickingItemId,
      },
    });
    await logTransition(tx, {
      entityType: "picking_order",
      entityId: pickingOrderId,
      fromState: order.status,
      toState: order.status,
      actorId,
      metadata: {
        action: "allocation_transferred_in",
        allocationId: targetAllocationId,
        itemId: pickingItemId,
        partNo: item.partNo,
        qty,
        beforeQty: targetBefore,
        afterQty: targetBefore + qty,
        sourceOrderId: source.sourceOrderId,
        sourceItemId: source.sourceItemId,
      },
    });

    await emitEvent(tx, {
      type: "allocation.computed",
      topics: ["/picking-orders"],
      data: {
        scope: "picking-order-item",
        pickingOrderId,
        pickingItemId,
        allocationId: targetAllocationId,
        action: "transferred",
        qty,
        sourceOrderId: source.sourceOrderId,
      },
    });

    return { pickingItemId, allocationId: targetAllocationId, qty };
  });
}

// Shared wipe/rebuild core for the two scoped recomputes above (mirrors
// allocateAll on purpose — keep them in sync). `scope` rides on the
// allocation.computed / allocation.finished event payloads so UIs can tell
// what triggered the run. `onlyOrderId` switches to the order-only scope
// (admin picking Re-allocate): demands are just that order's items and dock
// availability nets EVERY remaining allocation row (all other orders'
// rows survive the wipe). `timer` accumulates per-step wall-clock and is
// reported by the caller (dev diagnostic for slow recomputes).
async function runScopedAllocation(
  tx: DbOrTx,
  timer: StepTimer,
  partKeys: string[],
  scope: Record<string, unknown>,
  opts?: { onlyOrderId?: string }
): Promise<ScopedAllocateResult> {
  const summary: AllocateSummary = {
    demands: 0,
    fullyAllocated: 0,
    partiallyAllocated: 0,
    allocationsCreated: 0,
    allocationsRemoved: 0,
    skippedReceivingSources: 0,
    perfectMatched: 0,
    poMatched: 0,
  };

  if (partKeys.length === 0) {
    await refreshAllocationStatus(tx);
    await emitEvent(tx, {
      type: "allocation.finished",
      topics: ["/picking-orders", "/receiving-orders"],
      data: { ...summary, changed: false, ...scope },
    });
    return { ...summary, partKeys, changed: false, durationMs: timer.total() };
  }

  const orderOnly = !!opts?.onlyOrderId;
  const demands = await timer.measure("loadDemands", () => loadDemands(tx, partKeys, opts?.onlyOrderId));
  summary.demands = demands.length;

  const allocationKey = (
    pickingItemId: string,
    inventoryLotId: string | null,
    receivingInvoiceItemId: string | null,
    receivingOrderIdKey: string | null,
    qty: number
  ) => `${pickingItemId}|${inventoryLotId ?? ""}|${receivingInvoiceItemId ?? ""}|${receivingOrderIdKey ?? ""}|${qty}`;

  const beforeKeys: string[] = [];
  const afterKeys: string[] = [];
  const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
  const lotDelta = new Map<string, number>();
  // Rows pinned by the dock pre-passes (manual rows are excluded from the
  // before/after keys, so they need their own change signal).
  let prePassPinsCreated = 0;

  if (demands.length > 0) {
    const itemIds = demands.map((d) => d.pickingItemId);
    const existing = await timer.measure(
      "loadExisting",
      () =>
        queryAll<{
      id: string;
      pickingItemId: string;
      inventoryLotId: string | null;
      receivingInvoiceItemId: string | null;
      receivingOrderId: string | null;
      qty: number;
      manual: boolean;
      partNo: string;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      shelfCode: string | null;
      /** False when the lot's shelf_code is missing from shelves (upstream
       *  sync wrote it past the FK) — ledger rows must not carry the code. */
      shelfKnown: boolean;
      boxId: string | null;
    }>(
      tx,
      sql`SELECT a.id, a.picking_item_id AS "pickingItemId", a.inventory_lot_id AS "inventoryLotId",
                 a.receiving_invoice_item_id AS "receivingInvoiceItemId",
                 a.receiving_order_id AS "receivingOrderId", a.qty, a.manual,
                 COALESCE(il.part_no, rii.part_no, pi.part_no) AS "partNo",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode",
                 COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS "coo",
                 COALESCE(il.cow, rii.cow) AS "cow",
                 il.shelf_code AS "shelfCode",
                 (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code)) AS "shelfKnown",
                 COALESCE(il.box_id, rii.ctn_no) AS "boxId"
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          WHERE ${inArray(sql`a.picking_item_id`, itemIds)}`
        )
    );
    // Pinned manual allocations survive the wipe: excluded from the
    // net-change keys, not deleted, and their qty is pre-subtracted from each
    // item's auto-allocation demand below.
    const manualQtyByItem = new Map<string, number>();
    for (const a of existing) {
      if (a.manual) {
        manualQtyByItem.set(a.pickingItemId, (manualQtyByItem.get(a.pickingItemId) ?? 0) + a.qty);
        continue;
      }
      beforeKeys.push(allocationKey(a.pickingItemId, a.inventoryLotId, a.receivingInvoiceItemId, a.receivingOrderId, a.qty));
    }

    for (const a of existing) {
      if (a.manual) continue;
      summary.allocationsRemoved += 1;
      if (a.inventoryLotId) {
        lotDelta.set(a.inventoryLotId, (lotDelta.get(a.inventoryLotId) ?? 0) - a.qty);
      }
      txnRows.push({
        id: newId(),
        inventoryLotId: a.inventoryLotId,
        partNo: a.partNo,
        shelfCode: a.shelfKnown ? a.shelfCode : null,
        boxId: a.boxId,
        txnType: "RESERVE",
        qtyType: "reserved",
        qtyDelta: -a.qty,
        dateCode: a.dateCode,
        lotCode: a.lotCode,
        coo: a.coo,
        cow: a.cow,
        referenceType: "allocation",
        referenceId: a.id,
        receivingInvoiceItemId: a.receivingInvoiceItemId,
        txnReason: "recompute: release",
        txnAt: now(),
      });
    }
    await timer.measure("wipeDelete", () => tx.execute(sql`DELETE FROM allocations WHERE ${inArray(sql`picking_item_id`, itemIds)} AND NOT manual`));
    // Apply the wipe to lot allocated_qty up front so the per-demand source
    // queries see availability net of the removed reservations.
    await timer.measure("wipeLotDeltas", async () => {
      for (const [lotId, delta] of lotDelta) {
        if (delta === 0) continue;
        await tx.execute(sql`UPDATE inventory_lots il SET allocated_qty = allocated_qty + ${delta} WHERE il.id = ${lotId} AND (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code))`);
      }
    });
    lotDelta.clear();

    // ---- Dock pre-passes (spec
    // docs/superpowers/specs/2026-11-05-allocation-dock-match-ordering-design.md) ----
    // Scoped runs only. Source preference is strictly: shelf lots FIFO
    // first, then dock stock as PO match → qty perfect match → FIFO. The
    // passes below pin dock rows so they outrank plain FIFO within the run.
    // Part-key scope pins as MANUAL allocations: the pins outrank
    // priority_seq and survive every later wipe. Order-only scope pins as
    // NON-manual rows: inside one order there is no cross-order competition
    // to outrank, a manual pin would leak outside the selected order (never
    // wiped by anyone else), and non-manual pins keep identical rebuilds
    // idempotent through the net-change keys below. allocateAll runs none
    // of this. Pass PO runs for all demands before Pass A (a whole
    // receiving order's boxes == remainder), which runs for all demands
    // before Pass B (a single dock row == remainder) — PO binding outranks
    // qty exact-fit, and a big group match is not fragmented by a smaller
    // single-row match from an earlier-priority demand.
    const perfect: { d: DemandRow; remaining: number }[] = [];
    for (const raw of demands) {
      const d = resolveDemandLocation(raw);
      const remaining = Math.max(0, d.openQty - (manualQtyByItem.get(d.pickingItemId) ?? 0));
      if (remaining > 0) perfect.push({ d, remaining });
    }

    // Shelf-first simulation (no writes): consume lot availability in
    // priority order so the dock passes size themselves against the
    // remainder shelf stock cannot cover. Pins only touch dock rows, so
    // they cannot invalidate the simulation; the main loop below re-does
    // the real shelf allocation.
    const shelfSimUsed = new Map<string, number>();
    for (const item of perfect) {
      const lots = await timer.measure("sim.loadLots", () => loadLotSources(tx, item.d));
      for (const lot of lots) {
        if (item.remaining <= 0) break;
        const usable = lot.available - (shelfSimUsed.get(lot.lotId) ?? 0);
        if (usable <= 0) continue;
        const take = Math.min(usable, item.remaining);
        shelfSimUsed.set(lot.lotId, (shelfSimUsed.get(lot.lotId) ?? 0) + take);
        item.remaining -= take;
      }
    }

    const pinDockRows = async (
      item: DemandRow,
      pieces: { qty: number; recv: ReceivingRow }[],
      txnReason: string
    ): Promise<void> => {
      let pinned = 0;
      for (const p of pieces) {
        const id = newId();
        await tx.insert(allocations).values({
          id,
          pickingItemId: item.pickingItemId,
          inventoryLotId: null,
          receivingInvoiceItemId: p.recv.ctnNo ? p.recv.receivingInvoiceItemId : null,
          receivingOrderId: p.recv.ctnNo ? null : p.recv.receivingOrderId,
          qty: p.qty,
          manual: !orderOnly,
        });
        summary.allocationsCreated += 1;
        if (orderOnly) {
          // Non-manual pin: part of the rebuilt set, so it belongs in the
          // net-change keys (an identical rebuild reads changed = false).
          afterKeys.push(
            allocationKey(
              item.pickingItemId,
              null,
              p.recv.ctnNo ? p.recv.receivingInvoiceItemId : null,
              p.recv.ctnNo ? null : p.recv.receivingOrderId,
              p.qty
            )
          );
        } else {
          // Manual pins are excluded from the keys — count them for the
          // change signal instead.
          prePassPinsCreated += 1;
        }
        pinned += p.qty;
        txnRows.push({
          id: newId(),
          inventoryLotId: null,
          partNo: item.partNo,
          shelfCode: null,
          boxId: p.recv.ctnNo ?? null,
          txnType: "RESERVE",
          qtyType: "reserved",
          qtyDelta: p.qty,
          dateCode: p.recv.dateCode ?? null,
          referenceType: "allocation",
          referenceId: id,
          receivingInvoiceItemId: p.recv.ctnNo ? p.recv.receivingInvoiceItemId : null,
          txnReason,
          txnAt: now(),
        });
      }
      // Pre-subtract like existing manual pins: the main loop skips the
      // pinned qty and only allocates the rest. In-run visibility for later
      // demands comes from loadReceivingSources' surviving-rows netting
      // (manual/locked for part-key scope, every remaining row for
      // order-only scope — same tx).
      manualQtyByItem.set(item.pickingItemId, (manualQtyByItem.get(item.pickingItemId) ?? 0) + pinned);
    };

    if (allowDockStock()) {
      // Allocatable dock rows (NULL-pair rows are excluded here without
      // counting — the summary counter reflects the main loop's encounters
      // only) and the oldest available date code among them (FIFO order →
      // first non-null; null when every row's date code is NULL, which makes
      // the date-code gate vacuous).
      const allocatableRows = (rows: ReceivingRow[]) =>
        rows.filter((r) => r.orgId !== null && r.subInventoryCode !== null);
      const oldestDateCode = (rows: ReceivingRow[]) =>
        rows.find((r) => r.dateCode !== null)?.dateCode ?? null;

      // Pass PO — po_no binding: dock rows whose po_no equals the demand's
      // PO (item's additional_data.po_no, fallback the order's po_no) are
      // pinned first, in FIFO order, partial takes allowed. Date code is
      // ignored on purpose: the PO link is explicit business intent.
      for (const item of perfect) {
        if (item.remaining <= 0) continue;
        const demandPo = item.d.itemPoNo?.trim() || item.d.orderPoNo?.trim() || null;
        if (!demandPo) continue;
        const rows = allocatableRows(await timer.measure("passPO.loadRecv", () => loadReceivingSources(tx, item.d, orderOnly)));
        const pieces: { qty: number; recv: ReceivingRow }[] = [];
        for (const r of rows) {
          if (item.remaining <= 0) break;
          if (r.poNo?.trim() !== demandPo) continue;
          const take = Math.min(r.available, item.remaining);
          pieces.push({ qty: take, recv: r });
          item.remaining -= take;
        }
        if (pieces.length > 0) {
          await timer.measure("passPO.pin", () => pinDockRows(item.d, pieces, "recompute: po match"));
          summary.poMatched += 1;
        }
      }

      // Pass A — group match: ALL box rows of one receiving order for the
      // part sum exactly to the remaining dock qty AND every box carries the
      // oldest available dock date code → pin every box of that order.
      for (const item of perfect) {
        if (item.remaining <= 0) continue;
        const rows = allocatableRows(await timer.measure("passA.loadRecv", () => loadReceivingSources(tx, item.d, orderOnly)));
        const oldest = oldestDateCode(rows);
        const groups = new Map<string, { sum: number; rows: ReceivingRow[] }>();
        for (const r of rows) {
          if (!r.ctnNo) continue;
          const g = groups.get(r.receivingOrderId) ?? { sum: 0, rows: [] };
          g.sum += r.available;
          g.rows.push(r);
          groups.set(r.receivingOrderId, g);
        }
        for (const g of groups.values()) {
          if (g.sum === item.remaining && g.rows.every((r) => r.dateCode === oldest)) {
            await timer.measure("passA.pin", () =>
              pinDockRows(item.d, g.rows.map((r) => ({ qty: r.available, recv: r })), "recompute: perfect match")
            );
            summary.perfectMatched += 1;
            item.remaining = 0;
            break;
          }
        }
      }

      // Pass B — single-row match: one box / one order-level pool row at the
      // oldest dock date code exactly equals the remaining dock qty.
      for (const item of perfect) {
        if (item.remaining <= 0) continue;
        const rows = allocatableRows(await timer.measure("passB.loadRecv", () => loadReceivingSources(tx, item.d, orderOnly)));
        const oldest = oldestDateCode(rows);
        const hit = rows.find((r) => r.available === item.remaining && r.dateCode === oldest);
        if (hit) {
          await timer.measure("passB.pin", () => pinDockRows(item.d, [{ qty: hit.available, recv: hit }], "recompute: perfect match"));
          summary.perfectMatched += 1;
          item.remaining = 0;
        }
      }
    }

    const lotUsed = new Map<string, number>();
    const recvUsed = new Map<string, number>();

    for (const raw of demands) {
      const d = resolveDemandLocation(raw);
      // Pinned manual allocations pre-cover part (or all) of the open demand.
      let remaining = Math.max(0, d.openQty - (manualQtyByItem.get(d.pickingItemId) ?? 0));
      const allocatedForItem: { qty: number; lotId?: string; recv?: ReceivingRow }[] = [];

      const lots = await timer.measure("main.loadLots", () => loadLotSources(tx, d));
      for (const lot of lots) {
        if (remaining <= 0) break;
        const usable = lot.available - (lotUsed.get(lot.lotId) ?? 0);
        if (usable <= 0) continue;
        const take = Math.min(usable, remaining);
        allocatedForItem.push({ qty: take, lotId: lot.lotId });
        lotUsed.set(lot.lotId, (lotUsed.get(lot.lotId) ?? 0) + take);
        remaining -= take;
      }

      if (remaining > 0 && allowDockStock()) {
        const rows = await timer.measure("main.loadRecv", () => loadReceivingSources(tx, d, orderOnly));
        for (const r of rows) {
          if (remaining <= 0) break;
          if (r.orgId === null || r.subInventoryCode === null) {
            summary.skippedReceivingSources += 1;
            continue;
          }
          const key = r.ctnNo ? `item:${r.receivingInvoiceItemId}` : `order:${r.receivingOrderId}:${d.partNo}`;
          const usable = r.available - (recvUsed.get(key) ?? 0);
          if (usable <= 0) continue;
          const take = Math.min(usable, remaining);
          allocatedForItem.push({ qty: take, recv: r });
          recvUsed.set(key, (recvUsed.get(key) ?? 0) + take);
          remaining -= take;
        }
      }

      // Items covered only by pinned manual rows still pass through here so
      // their allocated_qty cache is refreshed (manual + auto).
      if (d.openQty - remaining <= 0) continue;
      if (remaining <= 0) summary.fullyAllocated += 1;
      else summary.partiallyAllocated += 1;

      await timer.measure("main.writes", async () => {
        for (const alloc of allocatedForItem) {
          const id = newId();
          await tx.insert(allocations).values({
            id,
            pickingItemId: d.pickingItemId,
            inventoryLotId: alloc.lotId ?? null,
            receivingInvoiceItemId: alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
            receivingOrderId: alloc.recv && !alloc.recv.ctnNo ? alloc.recv.receivingOrderId : null,
            qty: alloc.qty,
          });
          summary.allocationsCreated += 1;
          afterKeys.push(
            allocationKey(
              d.pickingItemId,
              alloc.lotId ?? null,
              alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
              alloc.recv && !alloc.recv.ctnNo ? alloc.recv.receivingOrderId : null,
              alloc.qty
            )
          );
          if (alloc.lotId) {
            lotDelta.set(alloc.lotId, (lotDelta.get(alloc.lotId) ?? 0) + alloc.qty);
          }
          txnRows.push({
            id: newId(),
            inventoryLotId: alloc.lotId ?? null,
            partNo: d.partNo,
            shelfCode: null,
            boxId: alloc.recv?.ctnNo ?? null,
            txnType: "RESERVE",
            qtyType: "reserved",
            qtyDelta: alloc.qty,
            dateCode: alloc.recv?.dateCode ?? null,
            referenceType: "allocation",
            referenceId: id,
            receivingInvoiceItemId: alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
            txnReason: "recompute: reserve",
            txnAt: now(),
          });
        }
        await tx.execute(
          sql`UPDATE picking_items SET allocated_qty = ${d.openQty - remaining}, last_update_date = ${now()} WHERE id = ${d.pickingItemId}`
        );
      });
    }

    await timer.measure("finalLotDeltas", async () => {
      for (const [lotId, delta] of lotDelta) {
        if (delta === 0) continue;
        await tx.execute(sql`UPDATE inventory_lots il SET allocated_qty = allocated_qty + ${delta} WHERE il.id = ${lotId} AND (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code))`);
      }
    });
    if (txnRows.length > 0) {
      await timer.measure("ledgerInsert", () => tx.insert(inventoryTransactions).values(txnRows));
    }
    // Demands with no source leave allocated_qty at 0.
    await timer.measure("zeroOut", () =>
      tx.execute(
        sql`UPDATE picking_items SET allocated_qty = 0, last_update_date = ${now()}
          WHERE ${inArray(sql`id`, itemIds)} AND id NOT IN (
            SELECT DISTINCT picking_item_id FROM allocations WHERE ${inArray(sql`picking_item_id`, itemIds)}
          )`
      )
    );
    if (summary.skippedReceivingSources > 0) {
      console.warn(
        `runScopedAllocation: skipped ${summary.skippedReceivingSources} receiving source(s) with a NULL item location pair (org_id/sub_inventory_code)`
      );
    }
  }

  const changed = prePassPinsCreated > 0 || beforeKeys.slice().sort().join("\n") !== afterKeys.slice().sort().join("\n");
  if (changed) {
    await timer.measure("emitComputed", () =>
      emitEvent(tx, {
        type: "allocation.computed",
        topics: ["/picking-orders"],
        data: { ...summary, ...scope },
      })
    );
  }
  await timer.measure("emitFinished", () =>
    emitEvent(tx, {
      type: "allocation.finished",
      topics: ["/picking-orders", "/receiving-orders"],
      data: { ...summary, changed, ...scope },
    })
  );
  await timer.measure("refreshStatus", () => refreshAllocationStatus(tx));
  return { ...summary, partKeys, changed, durationMs: timer.total() };
}

// ---------------------------------------------------------------------------
// Background scheduler. The engine is manual-only now: nothing schedules a
// fleet recompute automatically. The runner stays because snapshot restore
// serializes through it (awaitAllocationTask) and scheduleAllocateAll /
// awaitAllocateAll remain for tests + the dev escape hatch; triggers that
// arrive during a run coalesce into a single follow-up run.
// ---------------------------------------------------------------------------

let allocateActive = false;
let allocateQueued = false;
let queuedAfter = "";
let queuedRun: (db: AppDb) => Promise<unknown> = allocateAll;
let activeRecomputeRun: ((db: AppDb) => Promise<unknown>) | null = null;
const allocateWaiters: ((last: AllocationRunStatus["lastRun"]) => void)[] = [];
const allocationTasks: {
  after: string;
  run: (db: AppDb) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}[] = [];

// In-memory status of the background runner, exposed via GET
// /allocation/status so UIs can show a global "allocation running" indicator
// even for runs started by someone else (scoped confirm-arrival recompute is
// synchronous and does not appear here).
export interface AllocationRunStatus {
  running: boolean;
  queued: boolean;
  trigger: string | null;
  startedAt: string | null;
  lastRun:
    | (AllocateSummary & { finishedAt: string; durationMs: number; trigger: string })
    | null;
}

const runState: { trigger: string | null; startedAt: string | null; lastRun: AllocationRunStatus["lastRun"] } = {
  trigger: null,
  startedAt: null,
  lastRun: null,
};

export function getAllocationRunStatus(): AllocationRunStatus {
  return {
    running: allocateActive,
    queued: allocateQueued || allocationTasks.length > 0,
    trigger: runState.trigger,
    startedAt: runState.startedAt,
    lastRun: runState.lastRun,
  };
}

function pumpAllocationRunner(db: AppDb): void {
  if (allocateActive) return;
  allocateActive = true;
  void (async () => {
    while (allocateQueued || allocationTasks.length > 0) {
      const custom = allocationTasks.length > 0;
      const task = custom
        ? allocationTasks.shift()!
        : {
            after: queuedAfter,
            run: queuedRun,
            resolve: undefined,
            reject: undefined,
          };
      if (!custom) allocateQueued = false;
      activeRecomputeRun = custom ? null : task.run;
      runState.trigger = task.after;
      runState.startedAt = new Date().toISOString();
      try {
        await emitEvent(db, {
          type: "allocation.started",
          topics: ["/picking-orders", "/receiving-orders"],
          data: { trigger: task.after },
        });
      } catch (err) {
        console.error("allocation.started event failed", err);
      }
      const runStarted = Date.now();
      try {
        const summary = (await task.run(db)) as AllocateSummary | undefined;
        task.resolve?.(summary);
        runState.lastRun = {
          demands: summary?.demands ?? 0,
          fullyAllocated: summary?.fullyAllocated ?? 0,
          partiallyAllocated: summary?.partiallyAllocated ?? 0,
          allocationsCreated: summary?.allocationsCreated ?? 0,
          allocationsRemoved: summary?.allocationsRemoved ?? 0,
          skippedReceivingSources: summary?.skippedReceivingSources ?? 0,
          perfectMatched: summary?.perfectMatched ?? 0,
          poMatched: summary?.poMatched ?? 0,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - runStarted,
          trigger: task.after,
        };
      } catch (err) {
        if (task.reject) task.reject(err);
        else console.error(`allocateAll after ${task.after} failed`, err);
      }
      activeRecomputeRun = null;
    }
    allocateActive = false;
    runState.trigger = null;
    runState.startedAt = null;
    if (allocateQueued || allocationTasks.length > 0) {
      pumpAllocationRunner(db);
    } else {
      const waiters = allocateWaiters.splice(0);
      for (const waiter of waiters) waiter(runState.lastRun);
    }
  })();
}

export function scheduleAllocateAll(
  db: AppDb,
  after: string,
  run: (db: AppDb) => Promise<unknown> = allocateAll
): void {
  if (!allocateQueued) {
    queuedAfter = after;
    queuedRun = activeRecomputeRun ?? run;
  }
  allocateQueued = true;
  pumpAllocationRunner(db);
}

/** Queue a distinct operation without coalescing it into allocation recomputes. */
export function awaitAllocationTask<T>(db: AppDb, after: string, run: (db: AppDb) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    allocationTasks.push({
      after,
      run,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    pumpAllocationRunner(db);
  });
}

/**
 * Like scheduleAllocateAll, but the returned promise resolves once the
 * serialized runner has gone idle (this trigger AND every trigger that
 * arrived mid-run have been applied) — with the last run's summary. Request
 * paths that must report the settled fleet (the admin manual run) use this so
 * they cannot interleave with a background run: two concurrent allocateAll
 * passes each wipe and rebuild, which used to leave duplicate allocation rows.
 */
export function awaitAllocateAll(
  db: AppDb,
  after: string
): Promise<AllocationRunStatus["lastRun"]> {
  return new Promise((resolve) => {
    allocateWaiters.push(resolve);
    scheduleAllocateAll(db, after);
  });
}
