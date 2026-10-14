// Picking item → multi-source allocate form (admin availability modal:
// ONE Confirm for the whole form instead of a per-row Allocate button),
// plus the grouped variant that applies the same form to every line
// sharing one part_no at once (spec
// docs/superpowers/specs/2026-10-14-admin-picking-group-allocate-design.md).
//
// FINAL-STATE: each row states the total this picking item (or part group)
// should hold from that source afterwards, not an increment. Sources the
// form does not mention keep their current value — the dialog hides rows
// behind the date-code filter and the org/sub-inventory match filter, and
// releasing an invisible source would silently drop stock the admin never
// saw.
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
import { queryAll, queryGet, type DbOrTx } from "./query.js";
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

export interface AllocateGroupResult {
  partNo: string;
  /** The group's member picking items, in line order. */
  itemIds: string[];
  /** Σ (qty − Σ packages) over the group: the ceiling Σ allocations may not pass. */
  openQty: number;
  /** Σ allocations over the group after the change. */
  allocated: number;
  /** Per (item, source) change — the group total split across the lines. */
  changed: {
    key: string;
    pickingItemId: string;
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

function overAllocation(openQty: number, allocated: number): HTTPException {
  return new HTTPException(409, {
    message: "over_allocation",
    res: new Response(JSON.stringify({ error: "over_allocation", openQty, allocated }), {
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

/** Static per-source facts shared by every item the form touches. */
type SourceBase = Omit<ResolvedRow, "key" | "qty" | "override" | "current">;

// One row per source: two rows for the same lot would make "the final total
// from this source" ambiguous, and the apply loop would race itself.
function validateFormRows(rows: AllocateFormRow[]): void {
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
}

async function loadOrderWithLockGuard(
  db: AppDb,
  pickingOrderId: string
): Promise<{ id: string; status: string }> {
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
  return order;
}

type Tx = DbOrTx;

/** Resolve the form's sources: existence, availability, shelf knowledge. */
async function resolveFormSources(
  tx: Tx,
  rows: AllocateFormRow[]
): Promise<{ lots: Map<string, SourceBase>; recvs: Map<string, SourceBase> }> {
  const lotIds = rows.filter((r) => r.inventoryLotId).map((r) => r.inventoryLotId!);
  const recvIds = rows.filter((r) => r.receivingInvoiceItemId).map((r) => r.receivingInvoiceItemId!);

  const lots = new Map<string, SourceBase>();
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

  const recvs = new Map<string, SourceBase>();
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
  return { lots, recvs };
}

/**
 * Release `toFree` of one item's holdings from one source, deleting/shrinking
 * its allocation rows (engine rows first, then manual pins; oldest first
 * within each) with a RESERVE ledger row per touched row.
 */
async function releaseSourceQty(
  tx: Tx,
  pickingItemId: string,
  src: SourceBase,
  toFree: number,
  actorId: string
): Promise<void> {
  const col = src.kind === "lot" ? sql`inventory_lot_id` : sql`receiving_invoice_item_id`;
  const srcId = src.kind === "lot" ? src.inventoryLotId! : src.receivingInvoiceItemId!;
  const victims = await queryAll<{ id: string; qty: number }>(
    tx,
    sql`SELECT id, qty FROM allocations
        WHERE picking_item_id = ${pickingItemId} AND ${col} = ${srcId}
        ORDER BY manual ASC, created_date ASC`
  );
  let remaining = toFree;
  for (const a of victims) {
    if (remaining <= 0) break;
    const take = Math.min(a.qty, remaining);
    if (take === a.qty) {
      await tx.execute(sql`DELETE FROM allocations WHERE id = ${a.id}`);
    } else {
      await tx.execute(
        sql`UPDATE allocations SET qty = qty - ${take}, last_update_date = ${now()} WHERE id = ${a.id}`
      );
    }
    remaining -= take;
    await ledger(tx, {
      inventoryLotId: src.inventoryLotId,
      partNo: src.partNo,
      shelfCode: src.shelfCode,
      boxId: src.boxId,
      dateCode: src.dateCode,
      lotCode: src.lotCode,
      coo: src.coo,
      cow: src.cow,
      qtyDelta: -take,
      referenceId: a.id,
      receivingInvoiceItemId: src.receivingInvoiceItemId,
      actorId,
    });
  }
}

/**
 * Grow one item's holding from one source by `delta`: amend the row that
 * already holds this source on this item rather than inserting a second one —
 * the admin UI lists allocation rows separately, so a duplicate renders as a
 * duplicated line. Prefer a manual pin (then the oldest) and force
 * manual = true: the admin just stated a final total, and a non-manual row
 * would not survive the wipe/rebuild.
 */
async function growSourceQty(
  tx: Tx,
  pickingItemId: string,
  src: SourceBase,
  delta: number,
  actorId: string
): Promise<void> {
  const col = src.kind === "lot" ? sql`inventory_lot_id` : sql`receiving_invoice_item_id`;
  const srcId = src.kind === "lot" ? src.inventoryLotId! : src.receivingInvoiceItemId!;
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
      inventoryLotId: src.inventoryLotId,
      receivingInvoiceItemId: src.receivingInvoiceItemId,
      receivingOrderId: null,
      qty: delta,
      manual: true,
    });
  }
  await ledger(tx, {
    inventoryLotId: src.inventoryLotId,
    partNo: src.partNo,
    shelfCode: src.shelfCode,
    boxId: src.boxId,
    dateCode: src.dateCode,
    lotCode: src.lotCode,
    coo: src.coo,
    cow: src.cow,
    qtyDelta: delta,
    referenceId: allocationId,
    receivingInvoiceItemId: src.receivingInvoiceItemId,
    actorId,
  });
}

export async function allocatePickingItemFromSources(
  db: AppDb,
  pickingOrderId: string,
  pickingItemId: string,
  rows: AllocateFormRow[],
  actorId: string
): Promise<AllocateFormResult> {
  validateFormRows(rows);
  const order = await loadOrderWithLockGuard(db, pickingOrderId);

  const item = await queryGet<{ id: string; partNo: string }>(
    db,
    sql`SELECT id, part_no AS "partNo" FROM picking_items
        WHERE id = ${pickingItemId} AND picking_order_id = ${pickingOrderId}`
  );
  if (!item) throw new HTTPException(404, { message: "picking_item_not_found" });

  return db.transaction(async (tx) => {
    // --- resolve the rows: existence, availability, current holdings ------
    const { lots, recvs } = await resolveFormSources(tx, rows);

    // What this item already holds from each source (the form states totals,
    // so every comparison needs the current total, not just the delta).
    const current = new Map<string, number>();
    const loadCurrent = async (kind: "lot" | "receiving", ids: (string | null)[]) => {
      const real = ids.filter((x): x is string => !!x);
      if (real.length === 0) return;
      const col = kind === "lot" ? sql`inventory_lot_id` : sql`receiving_invoice_item_id`;
      const rowsNow = await queryAll<{ src: string; qty: number }>(
        tx,
        sql`SELECT ${col} AS src, SUM(qty)::int AS qty FROM allocations
            WHERE picking_item_id = ${pickingItemId} AND ${col} IN (${sql.join(real, sql`, `)})
            GROUP BY ${col}`
      );
      for (const r of rowsNow) current.set(`${kind === "lot" ? "l" : "r"}:${r.src}`, r.qty);
    };
    await loadCurrent("lot", rows.map((r) => r.inventoryLotId ?? null));
    await loadCurrent("receiving", rows.map((r) => r.receivingInvoiceItemId ?? null));

    const resolved: ResolvedRow[] = [];
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

    if (allocated > openQty) throw overAllocation(openQty, allocated);

    // --- per-row availability: shortfall, and whether an override can cover it
    const errors = validateAvailability(await loadSteppable(tx, [pickingItemId], resolved), resolved);
    if (errors.length > 0) throw rejected(errors);

    // --- apply: release the downs, then grow the ups ----------------------
    const changed: AllocateFormResult["changed"] = [];

    for (const r of resolved.filter((x) => x.qty < x.current)) {
      await releaseSourceQty(tx, pickingItemId, r, r.current - r.qty, actorId);
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

      await growSourceQty(tx, pickingItemId, r, delta, actorId);
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
 * Grouped variant (spec 2026-10-14-admin-picking-group-allocate-design.md):
 * the availability modal opened from the grouped items view. Each row's `qty`
 * is the desired final total from that source for EVERY line sharing
 * `partNo` on the order; the backend splits each source total into per-line
 * allocation rows — growth fills the lines in line order up to each line's
 * remaining headroom, shrink releases from the last line backwards. Same
 * final-state, all-or-nothing semantics as the per-item form.
 */
export async function allocatePickingGroupFromSources(
  db: AppDb,
  pickingOrderId: string,
  partNo: string,
  rows: AllocateFormRow[],
  actorId: string
): Promise<AllocateGroupResult> {
  validateFormRows(rows);
  const order = await loadOrderWithLockGuard(db, pickingOrderId);

  // Line order = the order the group's lines fill: line number (nulls last),
  // shipment number, then id for stability.
  const items = await queryAll<{ id: string; lineNumber: number | null; shipmentNumber: string | null }>(
    db,
    sql`SELECT id, line_number AS "lineNumber", shipment_number AS "shipmentNumber"
        FROM picking_items
        WHERE picking_order_id = ${pickingOrderId} AND part_no = ${partNo}
        ORDER BY line_number ASC NULLS LAST, shipment_number ASC NULLS LAST, id ASC`
  );
  if (items.length === 0) throw new HTTPException(404, { message: "picking_item_not_found" });
  const itemIds = items.map((i) => i.id);

  return db.transaction(async (tx) => {
    const { lots, recvs } = await resolveFormSources(tx, rows);

    // Per-line ceilings and totals: openQty = qty − Σ packages, allocated =
    // Σ allocations (all sources, mentioned or not).
    const states = await queryAll<{ id: string; openQty: number; allocated: number }>(
      tx,
      sql`SELECT pi.id,
                 (pi.qty - COALESCE(pkg.qty, 0)) AS "openQty",
                 COALESCE(alloc.qty, 0)::int AS "allocated"
          FROM picking_items pi
          LEFT JOIN (
            SELECT picking_item_id, SUM(qty)::int AS qty FROM picking_packages GROUP BY picking_item_id
          ) pkg ON pkg.picking_item_id = pi.id
          LEFT JOIN (
            SELECT picking_item_id, SUM(qty)::int AS qty FROM allocations GROUP BY picking_item_id
          ) alloc ON alloc.picking_item_id = pi.id
          WHERE pi.id IN (${sql.join(itemIds, sql`, `)})`
    );
    const stateByItem = new Map(states.map((s) => [s.id, s]));

    // Current holdings per (item, source) for the mentioned sources. Rows
    // pinned at the receiving ORDER level (no invoice item) have no source
    // key here — same treatment as the per-item form — but still count in
    // the per-line `allocated` totals above.
    const currentRows = await queryAll<{
      itemId: string;
      lotId: string | null;
      recvId: string | null;
      qty: number;
    }>(
      tx,
      sql`SELECT picking_item_id AS "itemId", inventory_lot_id AS "lotId",
                 receiving_invoice_item_id AS "recvId", SUM(qty)::int AS qty
          FROM allocations
          WHERE picking_item_id IN (${sql.join(itemIds, sql`, `)})
          GROUP BY picking_item_id, inventory_lot_id, receiving_invoice_item_id`
    );
    const current = new Map<string, number>(); // `${itemId}|${key}` -> qty
    for (const r of currentRows) {
      const key = r.lotId ? `l:${r.lotId}` : r.recvId ? `r:${r.recvId}` : null;
      if (key) current.set(`${r.itemId}|${key}`, r.qty);
    }
    const cur = (itemId: string, key: string) => current.get(`${itemId}|${key}`) ?? 0;

    const resolved: ResolvedRow[] = [];
    for (const r of rows) {
      const base = r.inventoryLotId ? lots.get(r.inventoryLotId) : recvs.get(r.receivingInvoiceItemId!);
      if (!base) throw new HTTPException(404, { message: "source_not_found" });
      const key = rowKey(r);
      resolved.push({
        ...base,
        key,
        qty: r.qty,
        override: r.override === true,
        current: itemIds.reduce((s, id) => s + cur(id, key), 0),
      });
    }

    // The ceiling, group-wide: Σ allocations over the group may not pass
    // Σ (qty − Σ packages). Because every grow below consumes exactly its
    // delta of that total headroom, this single check also guarantees the
    // distribution never strands a remainder.
    const openQty = itemIds.reduce((s, id) => s + (stateByItem.get(id)?.openQty ?? 0), 0);
    let allocated = itemIds.reduce((s, id) => s + (stateByItem.get(id)?.allocated ?? 0), 0);
    for (const r of resolved) allocated += r.qty - r.current;
    if (allocated > openQty) throw overAllocation(openQty, allocated);

    // Per-row availability at the group level (the group's own lines are
    // excluded from the override reclaim — their holdings are netted by the
    // distribution itself).
    const errors = validateAvailability(await loadSteppable(tx, itemIds, resolved), resolved);
    if (errors.length > 0) throw rejected(errors);

    // --- distribute: turn each source total into per (item, source) finals
    const planned = new Map<string, number>(); // `${itemId}|${key}` -> final qty
    const itemFinal = new Map(itemIds.map((id) => [id, stateByItem.get(id)?.allocated ?? 0]));
    const finalOf = (itemId: string, key: string) => planned.get(`${itemId}|${key}`) ?? cur(itemId, key);
    const changed: AllocateGroupResult["changed"] = [];

    for (const r of resolved) {
      if (r.qty === r.current) continue;
      if (r.qty < r.current) {
        // Shrink: release from the LAST line backwards so earlier lines keep
        // their allocations.
        let toFree = r.current - r.qty;
        for (const item of [...items].reverse()) {
          if (toFree <= 0) break;
          const c = finalOf(item.id, r.key);
          if (c <= 0) continue;
          const free = Math.min(c, toFree);
          planned.set(`${item.id}|${r.key}`, c - free);
          itemFinal.set(item.id, itemFinal.get(item.id)! - free);
          toFree -= free;
          changed.push({
            key: r.key,
            pickingItemId: item.id,
            inventoryLotId: r.inventoryLotId,
            receivingInvoiceItemId: r.receivingInvoiceItemId,
            from: cur(item.id, r.key),
            to: c - free,
          });
        }
      } else {
        // Grow: fill lines in line order, each up to its remaining headroom.
        let remaining = r.qty - r.current;
        for (const item of items) {
          if (remaining <= 0) break;
          const headroom = (stateByItem.get(item.id)?.openQty ?? 0) - itemFinal.get(item.id)!;
          const take = Math.min(headroom, remaining);
          if (take <= 0) continue;
          const c = finalOf(item.id, r.key);
          planned.set(`${item.id}|${r.key}`, c + take);
          itemFinal.set(item.id, itemFinal.get(item.id)! + take);
          remaining -= take;
          changed.push({
            key: r.key,
            pickingItemId: item.id,
            inventoryLotId: r.inventoryLotId,
            receivingInvoiceItemId: r.receivingInvoiceItemId,
            from: cur(item.id, r.key),
            to: c + take,
          });
        }
      }
    }

    // --- apply: release the downs, then grow the ups ----------------------
    const srcByKey = new Map(resolved.map((r) => [r.key, r]));

    for (const c of changed.filter((x) => x.to < x.from)) {
      await releaseSourceQty(tx, c.pickingItemId, srcByKey.get(c.key)!, c.from - c.to, actorId);
    }

    for (const r of resolved.filter((x) => x.qty > x.current)) {
      const shortfall = r.qty - r.current - r.available;
      // Reclaim first so the growths below fit: this raises the source's
      // availability by exactly `shortfall` (validated above).
      if (shortfall > 0) {
        await stealAllocationsOnSource(tx, {
          inventoryLotId: r.inventoryLotId,
          receivingInvoiceItemId: r.receivingInvoiceItemId,
          shortfall,
          override: true,
          thiefOrderId: pickingOrderId,
          thiefItemId: itemIds[0]!,
          excludeItemIds: itemIds,
          actorId,
        });
      }
      for (const c of changed.filter((x) => x.key === r.key && x.to > x.from)) {
        await growSourceQty(tx, c.pickingItemId, r, c.to - c.from, actorId);
      }
    }

    const touchedItems = new Set(changed.map((c) => c.pickingItemId));
    const touchedLots = new Set(
      changed.map((c) => c.inventoryLotId).filter((x): x is string => !!x)
    );
    for (const lotId of touchedLots) await recomputeLot(tx, lotId);
    for (const itemId of touchedItems) await recomputePickingItem(tx, itemId);
    await refreshAllocationStatus(tx);

    await logTransition(tx, {
      entityType: "picking_order",
      entityId: pickingOrderId,
      fromState: order.status,
      toState: order.status,
      actorId,
      metadata: {
        action: "allocate_group",
        partNo,
        itemIds,
        changes: changed.map((c) => ({ key: c.key, itemId: c.pickingItemId, from: c.from, to: c.to })),
      },
    });
    await emitEvent(tx, {
      type: "allocation.computed",
      topics: ["/picking-orders"],
      data: {
        scope: "picking-order-group",
        pickingOrderId,
        partNo,
        manual: true,
        changes: changed,
      },
    });

    return { partNo, itemIds, openQty, allocated, changed };
  });
}

/**
 * Per-row availability validation shared by both forms: growing onto a shelf
 * the layout table doesn't know would strand the pin (the scan-time lot
 * resolution excludes such lots, and the PICK ledger insert would violate the
 * shelf FK — same rule the engine's shelf-FK orphan exclusion applies), and a
 * shortfall above the source's availability needs an `override` row that can
 * actually reclaim it.
 */
function validateAvailability(
  steppable: Map<string, number>,
  resolved: ResolvedRow[]
): { key: string; reason: string }[] {
  const errors: { key: string; reason: string }[] = [];
  for (const r of resolved) {
    const delta = r.qty - r.current;
    if (delta <= 0) continue;
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
  return errors;
}

/**
 * How much of each source an override may reclaim: other picking items'
 * non-manual allocations on it, skipping orders whose PDA holds a live work
 * lock (their operator is scanning against those rows) — the same rule
 * `stealAllocationsOnSource` applies when it actually moves them. Used to
 * reject an unreachable row with a per-row reason instead of failing the
 * whole batch mid-apply. `excludeItemIds` are the form's own items (one item
 * for the per-item form, the whole part group for the grouped form).
 */
async function loadSteppable(
  tx: Tx,
  excludeItemIds: string[],
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
            AND NOT (a.picking_item_id IN (${sql.join(excludeItemIds, sql`, `)}))
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
  tx: Tx,
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
