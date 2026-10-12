// Receiving item → picking demand re-allocation (spec
// docs/superpowers/specs/2026-10-12-admin-receiving-reallocate-form-design.md).
//
// The admin dialog is a FINAL-STATE form: each row states the total the
// receiving item should hold on that picking item afterwards, not an
// increment. We release the rows that shrink before we grow the rows that
// grow, which is what makes this coherent:
//
//   * the per-item over-allocation guard (allocated + qty <= qty - picked)
//     is satisfied by construction — we only ever add qty to a row that has
//     room below its own unpicked requirement;
//   * the pool identity is self-balancing — Σ(final totals) <= receivedQty -
//     pickedQty holds because what one row gives up another row can take, so
//     no unrelated picking order is ever left short.
//
// Everything validates before anything writes and commits in one
// transaction: the admin is moving one pool of stock around, and a
// half-applied redistribution is much harder to reason about afterwards than
// a rejected form.

import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet } from "./query.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { emitEvent } from "./events.js";
import { logTransition, recomputePickingItem } from "./picking.js";
import { workLockExpiry, allocateForReceivingOrder } from "./allocate.js";
import { allocations, inventoryTransactions } from "./schema/index.js";

export interface ReallocateDemandRow {
  pickingItemId: string;
  /** Desired final total from this receiving item (0 releases the row). */
  qty: number;
}

export interface ReallocateDemandResult {
  itemId: string;
  /** The pool size: receivedQty - pickedQty. Compare against fromItemQty. */
  available: number;
  /** Σ holdings across every row after the change (must be <= available). */
  fromItemQty: number;
  changed: { pickingItemId: string; orderNo: string; from: number; to: number }[];
}

const OPEN_STATUSES = ["pending", "picking", "allocated"] as const;

/** Every reason one row can't be set to its requested total. */
function rowError(orderNo: string, reason: string): { pickingItemId: string; orderNo: string; reason: string } {
  return { pickingItemId: "", orderNo, reason };
}

export async function reallocateReceivingItemDemand(
  db: AppDb,
  receivingOrderId: string,
  receivingItemId: string,
  rows: ReallocateDemandRow[],
  actorId: string
): Promise<ReallocateDemandResult> {
  // Duplicate rows would make "the final total for this item" ambiguous.
  const wanted = new Map<string, number>();
  for (const r of rows) {
    if (!Number.isInteger(r.qty) || r.qty < 0) {
      throw new HTTPException(400, { message: "invalid_qty" });
    }
    if (wanted.has(r.pickingItemId)) {
      throw new HTTPException(400, { message: "duplicate_picking_item" });
    }
    wanted.set(r.pickingItemId, r.qty);
  }

  const item = await queryGet<{
    id: string;
    partNo: string;
    receivedQty: number;
    pickedQty: number;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    ctnNo: string | null;
  }>(
    db,
    sql`SELECT rii.id, rii.part_no AS "partNo", rii.received_qty AS "receivedQty",
               rii.picked_qty AS "pickedQty", rii.date_code AS "dateCode",
               rii.lot_code AS "lotCode", rii.coo, rii.cow, rii.ctn_no AS "ctnNo"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE rii.id = ${receivingItemId} AND ri.receiving_order_id = ${receivingOrderId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });

  // Current per-row holdings from this item, for BOTH the rows being edited and
  // the untouched ones (untouched rows still consume the pool).
  const current = await queryAll<{ pickingItemId: string; orderNo: string; from: number }>(
    db,
    sql`SELECT a.picking_item_id AS "pickingItemId", po.order_no AS "orderNo", SUM(a.qty)::int AS "from"
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE a.receiving_invoice_item_id = ${receivingItemId}
        GROUP BY a.picking_item_id, po.order_no`
  );
  const currentByItem = new Map(current.map((c) => [c.pickingItemId, c.from]));

  const result = await db.transaction(async (tx) => {
    // --- validate every row before touching anything ---------------------
    interface Target {
      pickingItemId: string;
      pickingOrderId: string;
      orderNo: string;
      orderStatus: string;
      qty: number;
      pickedQty: number;
      workingBy: string | null;
      workingAt: Date | null;
    }
    const ids = [...wanted.keys()];
    const targets: Target[] =
      ids.length === 0
        ? []
        : await queryAll<Target>(
            tx,
            sql`SELECT pi.id AS "pickingItemId", po.id AS "pickingOrderId", po.order_no AS "orderNo",
                       po.status AS "orderStatus", pi.qty, pi.picked_qty AS "pickedQty",
                       po.working_by AS "workingBy", po.working_at AS "workingAt"
                FROM picking_items pi
                JOIN picking_orders po ON po.id = pi.picking_order_id
                WHERE pi.id IN (${sql.join(ids, sql`, `)})`
          );
    const byItem = new Map(targets.map((t) => [t.pickingItemId, t]));

    const errors: { pickingItemId: string; orderNo: string; reason: string }[] = [];
    for (const [pickingItemId, to] of wanted) {
      const t = byItem.get(pickingItemId);
      if (!t) {
        errors.push(rowError(pickingItemId.slice(0, 8), "picking_item_not_found"));
        continue;
      }
      if (!OPEN_STATUSES.includes(t.orderStatus as (typeof OPEN_STATUSES)[number])) {
        errors.push({ pickingItemId, orderNo: t.orderNo, reason: "order_not_open" });
        continue;
      }
      if (t.workingBy && t.workingAt && t.workingAt >= workLockExpiry()) {
        errors.push({ pickingItemId, orderNo: t.orderNo, reason: "lock_held" });
        continue;
      }
      if (to > t.qty - t.pickedQty) {
        errors.push({ pickingItemId, orderNo: t.orderNo, reason: "over_allocation" });
        continue;
      }
    }
    if (errors.length > 0) {
      throw new HTTPException(409, {
        message: "reallocate_rejected",
        res: new Response(JSON.stringify({ error: "reallocate_rejected", rows: errors }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      });
    }

    // Pool check: the final total across EVERY row holding stock from this
    // item (edited rows at their requested value, untouched rows as they are).
    let plannedTotal = 0;
    for (const [pickingItemId, from] of currentByItem) {
      plannedTotal += wanted.has(pickingItemId) ? (wanted.get(pickingItemId) ?? 0) : from;
    }
    for (const [pickingItemId, to] of wanted) {
      if (!currentByItem.has(pickingItemId)) plannedTotal += to;
    }
    const available = item.receivedQty - item.pickedQty;
    if (plannedTotal > available) {
      throw new HTTPException(409, {
        message: "insufficient_available",
        res: new Response(
          JSON.stringify({ error: "insufficient_available", plannedTotal, available }),
          { status: 409, headers: { "content-type": "application/json" } }
        ),
      });
    }

    // --- apply: release the downs, then grow the ups ---------------------
    const changed: ReallocateDemandResult["changed"] = [];
    for (const [pickingItemId, to] of wanted) {
      const from = currentByItem.get(pickingItemId) ?? 0;
      if (from === to) continue;
      const t = byItem.get(pickingItemId)!;
      const delta = to - from;

      if (delta < 0) {
        // Manual pins first (an explicit admin decision), then engine
        // allocations; oldest first within each.
        const rowsToFree = await queryAll<{ id: string; qty: number }>(
          tx,
          sql`SELECT id, qty FROM allocations
              WHERE picking_item_id = ${pickingItemId} AND receiving_invoice_item_id = ${receivingItemId}
              ORDER BY manual ASC, created_date ASC`
        );
        let toFree = -delta;
        for (const a of rowsToFree) {
          if (toFree <= 0) break;
          const take = Math.min(a.qty, toFree);
          if (take === a.qty) {
            await tx.execute(sql`DELETE FROM allocations WHERE id = ${a.id}`);
          } else {
            await tx.execute(sql`UPDATE allocations SET qty = qty - ${take} WHERE id = ${a.id}`);
          }
          toFree -= take;
          await tx.insert(inventoryTransactions).values({
            id: newId(),
            inventoryLotId: null,
            partNo: item.partNo,
            shelfCode: null,
            boxId: item.ctnNo,
            txnType: "RESERVE",
            qtyType: "reserved",
            qtyDelta: -take,
            dateCode: item.dateCode,
            lotCode: item.lotCode,
            coo: item.coo,
            cow: item.cow,
            referenceType: "allocation",
            referenceId: a.id,
            receivingInvoiceItemId: receivingItemId,
            actorId,
            txnReason: "admin: reallocate",
            txnAt: now(),
          });
        }
      } else {
        // Grow: amend the row that already holds this receiving item's stock on
        // this picking item rather than inserting a second one — one picking
        // item + one receiving item is ONE allocation line, and the admin UI
        // lists each row separately (per-allocation (x), hover detail), so a
        // duplicate would read as a duplicated line. Prefer amending a manual
        // pin (then the oldest row) and force manual = true: the admin just
        // stated a final total, so the row must survive the wipe/rebuild, and a
        // non-manual row would not.
        const existing = await queryGet<{ id: string }>(
          tx,
          sql`SELECT id FROM allocations
              WHERE picking_item_id = ${pickingItemId} AND receiving_invoice_item_id = ${receivingItemId}
              ORDER BY manual DESC, created_date ASC
              LIMIT 1`
        );
        let allocationId: string;
        if (existing) {
          allocationId = existing.id;
          await tx.execute(
            sql`UPDATE allocations SET qty = qty + ${delta}, manual = true, last_update_date = ${now()} WHERE id = ${allocationId}`
          );
        } else {
          allocationId = newId();
          await tx.insert(allocations).values({
            id: allocationId,
            pickingItemId,
            inventoryLotId: null,
            receivingInvoiceItemId: receivingItemId,
            receivingOrderId: null,
            qty: delta,
            manual: true,
          });
        }
        await tx.insert(inventoryTransactions).values({
          id: newId(),
          inventoryLotId: null,
          partNo: item.partNo,
          shelfCode: null,
          boxId: item.ctnNo,
          txnType: "RESERVE",
          qtyType: "reserved",
          qtyDelta: delta,
          dateCode: item.dateCode,
          lotCode: item.lotCode,
          coo: item.coo,
          cow: item.cow,
          referenceType: "allocation",
          referenceId: allocationId,
          receivingInvoiceItemId: receivingItemId,
          actorId,
          txnReason: "admin: reallocate",
          txnAt: now(),
        });
      }

      await recomputePickingItem(tx, pickingItemId);
      await logTransition(tx, {
        entityType: "picking_order",
        entityId: t.pickingOrderId,
        fromState: t.orderStatus,
        toState: t.orderStatus,
        actorId,
        metadata: {
          action: delta < 0 ? "allocation_released" : "allocation_reallocated",
          itemId: pickingItemId,
          partNo: item.partNo,
          qty: Math.abs(delta),
          from,
          to,
          receivingInvoiceItemId: receivingItemId,
        },
      });
      await emitEvent(tx, {
        type: "allocation.computed",
        topics: ["/picking-orders"],
        data: {
          scope: "picking-order-item",
          pickingOrderId: t.pickingOrderId,
          pickingItemId,
          action: delta < 0 ? "released" : "reallocated",
          qty: Math.abs(delta),
        },
      });
      changed.push({ pickingItemId, orderNo: t.orderNo, from, to });
    }

    return { itemId: receivingItemId, available, fromItemQty: plannedTotal, changed };
  });

  // The engine tops up the freed demand from other sources, scoped to this
  // order's part keys (parts never compete, so this is cheap and fast enough
  // to answer with — same call the receiving-detail "Re-allocate" button
  // makes). The new pins are manual, which the wipe/rebuild preserves and
  // pre-subtracts from demand, so the form's distribution survives.
  await allocateForReceivingOrder(db, receivingOrderId);
  return result;
}