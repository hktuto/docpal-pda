// Picking item → multi-source allocate form (admin availability modal:
// ONE Confirm for the whole form instead of a per-row Allocate button).
//
// FINAL-STATE: each row states the total this picking item should hold from
// that source afterwards, not an increment. Sources the form does not mention
// keep their current value — the dialog hides rows behind the date-code filter
// and the org/sub-inventory match filter, and releasing an invisible source
// would silently drop stock the admin never saw.
//
// Releases are applied before growth, so the per-item over-allocation guard
// (Σ allocations <= qty − Σ packages) can be evaluated once against the FINAL
// total. Everything validates before anything writes and commits in one
// transaction: a form that cannot be applied is rejected whole, never
// half-applied.
//
// Rows that pin above their source's availability carry `override: true` and
// reclaim the shortfall from other orders' non-manual allocations through the
// same helper the single-row Allocate uses (stealAllocationsOnSource).

import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet } from "./query.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { emitEvent } from "./events.js";
import { logTransition, recomputeLot, recomputePickingItem } from "./picking.js";
import { workLockExpiry, stealAllocationsOnSource, refreshAllocationStatus } from "./allocate.js";
import { allocations, inventoryTransactions } from "./schema/index.js";

export interface AllocateFormRow {
  inventoryLotId?: string | null;
  receivingInvoiceItemId?: string | null;
  /** Desired final total from this source for the item (0 releases it). */
  qty: number;
  /** Pin above the source's availability, reclaiming the shortfall. */
  override?: boolean;
}

export interface AllocateFormResult {
  pickingItemId: string;
  /** qty − Σ packages: the ceiling Σ allocations may not pass. */
  openQty: number;
  /** Σ allocations for the item after the change. */
  allocated: number;
  changed: {
    key: string;
    inventoryLotId: string | null;
    receivingInvoiceItemId: string | null;
    from: number;
    to: number;
  }[];
}

/** `l:<lotId>` / `r:<receivingItemId>` — stable keys the UI matches errors on. */
function rowKey(r: { inventoryLotId?: string | null; receivingInvoiceItemId?: string | null }): string {
  return r.inventoryLotId ? `l:${r.inventoryLotId}` : `r:${r.receivingInvoiceItemId}`;
}

function rejected(rows: { key: string; reason: string }[]): HTTPException {
  return new HTTPException(409, {
    message: "allocate_rejected",
    res: new Response(JSON.stringify({ error: "allocate_rejected", rows }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });
}

interface ResolvedRow {
  key: string;
  kind: "lot" | "receiving";
  inventoryLotId: string | null;
  receivingInvoiceItemId: string | null;
  qty: number;
  override: boolean;
  available: number;
  current: number;
  /** False when the lot's shelf_code is missing from shelves (upstream sync
   *  can write such rows past the FK) — growth is rejected, and ledger rows
   *  must not carry the code (inventory_transactions has the same FK). */
  shelfKnown: boolean;
  /** Ledger fields for the source, reused for the RESERVE rows. */
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
}

export async function allocatePickingItemFromSources(
  db: AppDb,
  pickingOrderId: string,
  pickingItemId: string,
  rows: AllocateFormRow[],
  actorId: string
): Promise<AllocateFormResult> {
  // One row per source: two rows for the same lot would make "the final total
  // from this source" ambiguous, and the apply loop would race itself.
  const seen = new Set<string>();
  for (const r of rows) {
    const hasLot = !!r.inventoryLotId;
    const hasRecv = !!r.receivingInvoiceItemId;
    if (hasLot === hasRecv) throw new HTTPException(400, { message: "source_required" });
    if (!Number.isInteger(r.qty) || r.qty < 0) throw new HTTPException(400, { message: "invalid_qty" });
    const key = rowKey(r);
    if (seen.has(key)) throw new HTTPException(400, { message: "duplicate_source" });
    seen.add(key);
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

  const item = await queryGet<{ id: string; partNo: string }>(
    db,
    sql`SELECT id, part_no AS "partNo" FROM picking_items
        WHERE id = ${pickingItemId} AND picking_order_id = ${pickingOrderId}`
  );
  if (!item) throw new HTTPException(404, { message: "picking_item_not_found" });

  return db.transaction(async (tx) => {
    // --- resolve the rows: existence, availability, current holdings ------
    const resolved: ResolvedRow[] = [];
    const lotIds = rows.filter((r) => r.inventoryLotId).map((r) => r.inventoryLotId!);
    const recvIds = rows.filter((r) => r.receivingInvoiceItemId).map((r) => r.receivingInvoiceItemId!);

    const lots = new Map<string, Omit<ResolvedRow, "key" | "qty" | "override" | "current">>();
    if (lotIds.length > 0) {
      const found = await queryAll<{
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
            FROM inventory_lots WHERE id IN (${sql.join(lotIds, sql`, `)})`
      );
      if (found.length !== lotIds.length) throw new HTTPException(404, { message: "inventory_lot_not_found" });
      for (const l of found) {
        lots.set(l.id, {
          kind: "lot",
          inventoryLotId: l.id,
          receivingInvoiceItemId: null,
          available: l.available,
          shelfKnown: l.shelfKnown,
          partNo: l.partNo,
          dateCode: l.dateCode,
          lotCode: l.lotCode,
          coo: l.coo,
          cow: l.cow,
          // Never hand an unknown shelf code to the ledger — the insert would
          // violate the shelves FK and roll the whole form back with a 500.
          shelfCode: l.shelfKnown ? l.shelfCode : null,
          boxId: l.boxId,
        });
      }
    }

    const recvs = new Map<string, Omit<ResolvedRow, "key" | "qty" | "override" | "current">>();
    if (recvIds.length > 0) {
      const found = await queryAll<{
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
            WHERE rii.id IN (${sql.join(recvIds, sql`, `)})`
      );
      if (found.length !== recvIds.length) {
        throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
      }
      for (const r of found) {
        recvs.set(r.id, {
          kind: "receiving",
          inventoryLotId: null,
          receivingInvoiceItemId: r.id,
          available: r.available,
          shelfKnown: true,
          partNo: r.partNo,
          dateCode: r.dateCode,
          lotCode: r.lotCode,
          coo: r.coo,
          cow: r.cow,
          shelfCode: null,
          boxId: r.boxId,
        });
      }
    }

    // What this item already holds from each source (the form states totals,
    // so every comparison needs the current total, not just the delta).
    const current = new Map<string, number>();
    const loadCurrent = async (kind: "lot" | "receiving", ids: string[]) => {
      if (ids.length === 0) return;
      const col = kind === "lot" ? sql`inventory_lot_id` : sql`receiving_invoice_item_id`;
      const rowsNow = await queryAll<{ src: string; qty: number }>(
        tx,
        sql`SELECT ${col} AS src, SUM(qty)::int AS qty FROM allocations
            WHERE picking_item_id = ${pickingItemId} AND ${col} IN (${sql.join(ids, sql`, `)})
            GROUP BY ${col}`
      );
      for (const r of rowsNow) current.set(`${kind === "lot" ? "l" : "r"}:${r.src}`, r.qty);
    };
    await loadCurrent("lot", lotIds);
    await loadCurrent("receiving", recvIds);

    for (const r of rows) {
      const base = r.inventoryLotId ? lots.get(r.inventoryLotId) : recvs.get(r.receivingInvoiceItemId!);
      if (!base) throw new HTTPException(404, { message: "source_not_found" });
      resolved.push({
        ...base,
        key: rowKey(r),
        qty: r.qty,
        override: r.override === true,
        current: current.get(rowKey(r)) ?? 0,
      });
    }

    // The ceiling: Σ allocations for this item may not pass qty − Σ packages.
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
    const openQty = open?.openQty ?? 0;
    let allocated = open?.allocated ?? 0;
    for (const r of resolved) allocated += r.qty - r.current;

    if (allocated > openQty) {
      throw new HTTPException(409, {
        message: "over_allocation",
        res: new Response(
          JSON.stringify({ error: "over_allocation", openQty, allocated }),
          { status: 409, headers: { "content-type": "application/json" } }
        ),
      });
    }

    // --- per-row availability: shortfall, and whether an override can cover it
    const errors: { key: string; reason: string }[] = [];
    const steppable = await loadSteppable(tx, pickingItemId, resolved);
    for (const r of resolved) {
      const delta = r.qty - r.current;
      if (delta <= 0) continue;
      // Growing onto a shelf the layout table doesn't know would strand the
      // pin: the scan-time lot resolution excludes such lots, and the PICK
      // ledger insert would violate the shelf FK. Same rule the engine's
      // shelf-FK orphan exclusion applies.
      if (r.kind === "lot" && !r.shelfKnown) {
        errors.push({ key: r.key, reason: "shelf_not_found" });
        continue;
      }
      const shortfall = delta - r.available;
      if (shortfall <= 0) continue;
      if (!r.override) {
        errors.push({ key: r.key, reason: "insufficient_available" });
        continue;
      }
      if ((steppable.get(r.key) ?? 0) < shortfall) {
        errors.push({ key: r.key, reason: "insufficient_available" });
      }
    }
    if (errors.length > 0) throw rejected(errors);

    // --- apply: release the downs, then grow the ups ----------------------
    const changed: AllocateFormResult["changed"] = [];

    for (const r of resolved.filter((x) => x.qty < x.current)) {
      const delta = r.qty - r.current; // negative
      const col = r.kind === "lot" ? sql`inventory_lot_id` : sql`receiving_invoice_item_id`;
      const srcId = r.kind === "lot" ? r.inventoryLotId! : r.receivingInvoiceItemId!;
      // Manual pins first (an explicit admin decision), then engine rows;
      // oldest first within each.
      const victims = await queryAll<{ id: string; qty: number }>(
        tx,
        sql`SELECT id, qty FROM allocations
            WHERE picking_item_id = ${pickingItemId} AND ${col} = ${srcId}
            ORDER BY manual ASC, created_date ASC`
      );
      let toFree = -delta;
      for (const a of victims) {
        if (toFree <= 0) break;
        const take = Math.min(a.qty, toFree);
        if (take === a.qty) {
          await tx.execute(sql`DELETE FROM allocations WHERE id = ${a.id}`);
        } else {
          await tx.execute(
            sql`UPDATE allocations SET qty = qty - ${take}, last_update_date = ${now()} WHERE id = ${a.id}`
          );
        }
        toFree -= take;
        await ledger(tx, {
          inventoryLotId: r.inventoryLotId,
          partNo: r.partNo,
          shelfCode: r.shelfCode,
          boxId: r.boxId,
          dateCode: r.dateCode,
          lotCode: r.lotCode,
          coo: r.coo,
          cow: r.cow,
          qtyDelta: -take,
          referenceId: a.id,
          receivingInvoiceItemId: r.receivingInvoiceItemId,
          actorId,
        });
      }
      changed.push({
        key: r.key,
        inventoryLotId: r.inventoryLotId,
        receivingInvoiceItemId: r.receivingInvoiceItemId,
        from: r.current,
        to: r.qty,
      });
    }

    for (const r of resolved.filter((x) => x.qty > x.current)) {
      const delta = r.qty - r.current;
      const shortfall = delta - r.available;

      // Reclaim first so the grow below fits: this raises the source's
      // availability by exactly `shortfall` (validated above).
      if (shortfall > 0) {
        await stealAllocationsOnSource(tx, {
          inventoryLotId: r.inventoryLotId,
          receivingInvoiceItemId: r.receivingInvoiceItemId,
          shortfall,
          override: true,
          thiefOrderId: pickingOrderId,
          thiefItemId: pickingItemId,
          actorId,
        });
      }

      const col = r.kind === "lot" ? sql`inventory_lot_id` : sql`receiving_invoice_item_id`;
      const srcId = r.kind === "lot" ? r.inventoryLotId! : r.receivingInvoiceItemId!;
      // Amend the row that already holds this source on this item rather than
      // inserting a second one — the admin UI lists allocation rows
      // separately, so a duplicate renders as a duplicated line. Prefer a
      // manual pin (then the oldest) and force manual = true: the admin just
      // stated a final total, and a non-manual row would not survive the
      // wipe/rebuild.
      const existing = await queryGet<{ id: string }>(
        tx,
        sql`SELECT id FROM allocations
            WHERE picking_item_id = ${pickingItemId} AND ${col} = ${srcId}
            ORDER BY manual DESC, created_date ASC
            LIMIT 1`
      );
      let allocationId: string;
      if (existing) {
        allocationId = existing.id;
        await tx.execute(
          sql`UPDATE allocations SET qty = qty + ${delta}, manual = true, last_update_date = ${now()}
              WHERE id = ${allocationId}`
        );
      } else {
        allocationId = newId();
        await tx.insert(allocations).values({
          id: allocationId,
          pickingItemId,
          inventoryLotId: r.inventoryLotId,
          receivingInvoiceItemId: r.receivingInvoiceItemId,
          receivingOrderId: null,
          qty: delta,
          manual: true,
        });
      }
      await ledger(tx, {
        inventoryLotId: r.inventoryLotId,
        partNo: r.partNo,
        shelfCode: r.shelfCode,
        boxId: r.boxId,
        dateCode: r.dateCode,
        lotCode: r.lotCode,
        coo: r.coo,
        cow: r.cow,
        qtyDelta: delta,
        referenceId: allocationId,
        receivingInvoiceItemId: r.receivingInvoiceItemId,
        actorId,
      });
      changed.push({
        key: r.key,
        inventoryLotId: r.inventoryLotId,
        receivingInvoiceItemId: r.receivingInvoiceItemId,
        from: r.current,
        to: r.qty,
      });
    }

    for (const r of resolved) {
      if (r.inventoryLotId && r.qty !== r.current) await recomputeLot(tx, r.inventoryLotId);
    }
    await recomputePickingItem(tx, pickingItemId);
    await refreshAllocationStatus(tx);

    // One item, one order, one form submit — a single audit entry carrying
    // every row change beats one per source.
    await logTransition(tx, {
      entityType: "picking_order",
      entityId: pickingOrderId,
      fromState: order.status,
      toState: order.status,
      actorId,
      metadata: {
        action: "allocate_form",
        itemId: pickingItemId,
        partNo: item.partNo,
        changes: changed.map((c) => ({ key: c.key, from: c.from, to: c.to })),
      },
    });
    await emitEvent(tx, {
      type: "allocation.computed",
      topics: ["/picking-orders"],
      data: {
        scope: "picking-order-item",
        pickingOrderId,
        pickingItemId,
        manual: true,
        changes: changed,
      },
    });

    return { pickingItemId, openQty, allocated, changed };
  });
}

/**
 * How much of each source an override may reclaim: other picking items'
 * non-manual allocations on it, skipping orders whose PDA holds a live work
 * lock (their operator is scanning against those rows) — the same rule
 * `stealAllocationsOnSource` applies when it actually moves them. Used to
 * reject an unreachable row with a per-row reason instead of failing the
 * whole batch mid-apply.
 */
async function loadSteppable(
  tx: Parameters<typeof queryAll>[0],
  pickingItemId: string,
  rows: ResolvedRow[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const expiry = workLockExpiry();

  const load = async (kind: "lot" | "receiving") => {
    const scoped = rows.filter((r) => r.kind === kind && r.override);
    if (scoped.length === 0) return;
    const col = kind === "lot" ? sql`a.inventory_lot_id` : sql`a.receiving_invoice_item_id`;
    const ids = scoped.map((r) => (kind === "lot" ? r.inventoryLotId! : r.receivingInvoiceItemId!));
    const found = await queryAll<{ src: string; qty: number }>(
      tx,
      sql`SELECT ${col} AS src, COALESCE(SUM(a.qty), 0)::int AS qty
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          WHERE a.manual = false
            AND a.picking_item_id <> ${pickingItemId}
            AND ${col} IN (${sql.join(ids, sql`, `)})
            AND (po.working_by IS NULL OR po.working_at IS NULL OR po.working_at < ${expiry})
          GROUP BY ${col}`
    );
    for (const f of found) out.set(`${kind === "lot" ? "l" : "r"}:${f.src}`, f.qty);
  };
  await load("lot");
  await load("receiving");
  return out;
}

/** One RESERVE ledger row for an allocation delta (shared by both loops). */
async function ledger(
  tx: Parameters<typeof queryAll>[0],
  input: {
    inventoryLotId: string | null;
    partNo: string;
    shelfCode: string | null;
    boxId: string | null;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    qtyDelta: number;
    referenceId: string;
    receivingInvoiceItemId: string | null;
    actorId: string;
  }
): Promise<void> {
  await tx.insert(inventoryTransactions).values({
    id: newId(),
    inventoryLotId: input.inventoryLotId,
    partNo: input.partNo,
    shelfCode: input.shelfCode,
    boxId: input.boxId,
    txnType: "RESERVE",
    qtyType: "reserved",
    qtyDelta: input.qtyDelta,
    dateCode: input.dateCode,
    lotCode: input.lotCode,
    coo: input.coo,
    cow: input.cow,
    referenceType: "allocation",
    referenceId: input.referenceId,
    receivingInvoiceItemId: input.receivingInvoiceItemId,
    actorId: input.actorId,
    txnReason: "admin: allocate form",
    txnAt: now(),
  });
}
