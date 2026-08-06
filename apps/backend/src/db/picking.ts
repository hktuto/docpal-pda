import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { inArray, sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { transactionLogs, inventoryTransactions } from "./schema/index.js";
import { nextBoxId } from "./boxes.js";
import { now } from "./now.js";
import { emitEvent } from "./events.js";
import { workLockExpiry } from "./allocate.js";
import { isStepEnabled } from "../config.js";
import { completeMeasuringTaskTx } from "./measuring.js";

// ---------------------------------------------------------------------------
// Picking flow (ported from apps/api pickScan.ts + measure.ts + pickingIssues.ts,
// adapted to the new schema: org_id locations, order-level receiving
// allocations, inventory_transactions ledger, transaction_logs).
//
// Scan-to-pick consumes an allocation into picking_packages rows (the boxing
// truth — shipping_box_items is never written, plan decision 4):
//   - lot source: lot total_qty −qty (+ allocated_qty recomputed), one package
//     ('inventory_lot', lot id)
//   - boxed receiving line: receiving_invoice_items.picked_qty += qty, one
//     package ('receiving_invoice_item', rii id)
//   - order-level receiving source (allocation against a no-box line — the old
//     API had no such source): the qty is distributed FIFO (date_code ASC
//     NULLS LAST) across the order's lines for the part, one package per
//     consumed portion stamped ('receiving_order', receiving order id) with
//     the portion line's batch attrs; removal credits back reverse-FIFO.
// Every scan writes two PICK ledger rows per portion (reserved −qty for the
// consumed allocation / on_hand −qty for the stock leaving); removing a
// package reverses the source, the allocation, and the ledger rows.
// picking_items.picked_qty tracks BOXED packages only (old recomputePickingItem
// semantics), so an order auto-finishes (→ measuring_tasks row) when its last
// package is boxed. The caller runs allocateAll after scan/remove commits.
// ---------------------------------------------------------------------------

async function assertActor(tx: DbOrTx, actorId: string): Promise<void> {
  const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${actorId}`);
  if (!actor) throw new HTTPException(400, { message: "actor_not_found" });
}

async function logTransition(
  tx: DbOrTx,
  entry: {
    entityType: string;
    entityId: string;
    fromState: string | null;
    toState: string;
    actorId: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.insert(transactionLogs).values({
    id: newId(),
    entityType: entry.entityType,
    entityId: entry.entityId,
    fromState: entry.fromState,
    toState: entry.toState,
    actorId: entry.actorId,
    metadata: entry.metadata ?? {},
    createdDate: now(),
  });
}

/** picking_items: allocated_qty = Σ allocations, picked_qty = Σ BOXED packages (old semantics);
 *  status = 'picked' once picked_qty covers qty, else 'pending'. */
async function recomputePickingItem(tx: DbOrTx, pickingItemId: string): Promise<void> {
  const alloc = await queryGet<{ s: number }>(
    tx,
    sql`SELECT COALESCE(SUM(qty), 0)::int AS s FROM allocations WHERE picking_item_id = ${pickingItemId}`
  );
  const boxed = await queryGet<{ s: number }>(
    tx,
    sql`SELECT COALESCE(SUM(qty), 0)::int AS s FROM picking_packages
        WHERE picking_item_id = ${pickingItemId} AND shipping_box_id IS NOT NULL`
  );
  await queryRun(
    tx,
    sql`UPDATE picking_items SET allocated_qty = ${alloc?.s ?? 0}, picked_qty = ${boxed?.s ?? 0},
          status = CASE WHEN ${boxed?.s ?? 0} >= qty THEN 'picked' ELSE 'pending' END,
          last_update_date = ${now()}
        WHERE id = ${pickingItemId}`
  );
}

/** inventory_lots.allocated_qty = Σ allocations (available_qty is generated). */
async function recomputeLot(tx: DbOrTx, lotId: string): Promise<void> {
  const alloc = await queryGet<{ s: number }>(
    tx,
    sql`SELECT COALESCE(SUM(qty), 0)::int AS s FROM allocations WHERE inventory_lot_id = ${lotId}`
  );
  await queryRun(tx, sql`UPDATE inventory_lots SET allocated_qty = ${alloc?.s ?? 0} WHERE id = ${lotId}`);
}

/** Stock change in a shelf box invalidates verification: reset item flags, verified → closed. */
async function markShelfBoxStockChanged(tx: DbOrTx, shelfBoxId: string): Promise<void> {
  await queryRun(
    tx,
    sql`UPDATE shelf_box_items SET verified = false, verified_at = NULL WHERE shelf_box_id = ${shelfBoxId}`
  );
  await queryRun(tx, sql`UPDATE shelf_boxes SET status = 'closed' WHERE id = ${shelfBoxId} AND status = 'verified'`);
}

interface OrderState {
  id: string;
  status: string;
}

async function loadOrderForWrite(tx: DbOrTx, orderId: string): Promise<OrderState> {
  const order = await queryGet<OrderState>(tx, sql`SELECT id, status FROM picking_orders WHERE id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });
  return order;
}

function assertOrderWritable(order: OrderState): void {
  if (order.status === "issue") throw new HTTPException(409, { message: "picking_order_has_open_issue" });
  if (order.status === "finished") throw new HTTPException(409, { message: "picking_order_already_finished" });
}

interface ShippingBoxRow {
  id: string;
  pickingOrderId: string | null;
  status: string;
  boxSize: string | null;
  netWeight: number | null;
  grossWeight: number | null;
  destinationCountry: string | null;
  createdDate: Date;
}

async function loadShippingBox(tx: DbOrTx, boxId: string): Promise<ShippingBoxRow> {
  const box = await queryGet<ShippingBoxRow>(
    tx,
    sql`SELECT id, picking_order_id AS "pickingOrderId", status, box_size AS "boxSize",
               net_weight AS "netWeight", gross_weight AS "grossWeight",
               destination_country AS "destinationCountry", created_date AS "createdDate"
        FROM shipping_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shipping_box_not_found" });
  return box;
}

/** Shrink an allocation by qty (the row stays at 0 when fully consumed), then recompute. */
async function reduceAllocation(tx: DbOrTx, allocationId: string, qty: number): Promise<void> {
  await queryRun(tx, sql`UPDATE allocations SET qty = qty - ${qty}, last_update_date = ${now()} WHERE id = ${allocationId}`);
  const a = await queryGet<{ pickingItemId: string; inventoryLotId: string | null }>(
    tx,
    sql`SELECT picking_item_id AS "pickingItemId", inventory_lot_id AS "inventoryLotId" FROM allocations WHERE id = ${allocationId}`
  );
  if (a) {
    await recomputePickingItem(tx, a.pickingItemId);
    if (a.inventoryLotId) await recomputeLot(tx, a.inventoryLotId);
  }
}

/** Find-or-create the allocation for (picking item, source) and add qty back. */
async function bumpAllocation(
  tx: DbOrTx,
  a: { pickingItemId: string; qty: number; inventoryLotId?: string; receivingInvoiceItemId?: string; receivingOrderId?: string }
): Promise<void> {
  const existing = await queryGet<{ id: string }>(
    tx,
    a.inventoryLotId
      ? sql`SELECT id FROM allocations WHERE picking_item_id = ${a.pickingItemId} AND inventory_lot_id = ${a.inventoryLotId}`
      : a.receivingInvoiceItemId
        ? sql`SELECT id FROM allocations WHERE picking_item_id = ${a.pickingItemId} AND receiving_invoice_item_id = ${a.receivingInvoiceItemId}`
        : sql`SELECT id FROM allocations WHERE picking_item_id = ${a.pickingItemId} AND receiving_order_id = ${a.receivingOrderId}`
  );
  if (existing) {
    await queryRun(tx, sql`UPDATE allocations SET qty = qty + ${a.qty}, last_update_date = ${now()} WHERE id = ${existing.id}`);
  } else {
    await queryRun(
      tx,
      sql`INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, receiving_invoice_item_id, receiving_order_id, created_date, last_update_date)
          VALUES (${newId()}, ${a.pickingItemId}, ${a.qty},
                  ${a.inventoryLotId ?? null}, ${a.receivingInvoiceItemId ?? null}, ${a.receivingOrderId ?? null},
                  ${now()}, ${now()})`
    );
  }
  await recomputePickingItem(tx, a.pickingItemId);
  if (a.inventoryLotId) await recomputeLot(tx, a.inventoryLotId);
}

/** Box a package (picking_packages is the truth; no shipping_box_items mirror). */
async function assignPackageToBoxTx(tx: DbOrTx, packageId: string, boxId: string): Promise<void> {
  const pkg = await queryGet<{ pickingItemId: string }>(
    tx,
    sql`SELECT picking_item_id AS "pickingItemId" FROM picking_packages WHERE id = ${packageId}`
  );
  if (!pkg) return;
  await queryRun(tx, sql`UPDATE picking_packages SET shipping_box_id = ${boxId}, last_update_date = ${now()} WHERE id = ${packageId}`);
  await recomputePickingItem(tx, pkg.pickingItemId);
}

/** Unbox a package: clear shipping_box_id (and the verified flag, like the old code). */
async function unassignPackageFromBoxTx(tx: DbOrTx, packageId: string): Promise<void> {
  const pkg = await queryGet<{ pickingItemId: string; shippingBoxId: string | null }>(
    tx,
    sql`SELECT picking_item_id AS "pickingItemId", shipping_box_id AS "shippingBoxId" FROM picking_packages WHERE id = ${packageId}`
  );
  if (!pkg || pkg.shippingBoxId === null) return;
  await queryRun(
    tx,
    sql`UPDATE picking_packages SET shipping_box_id = NULL, verified = false, last_update_date = ${now()} WHERE id = ${packageId}`
  );
  await recomputePickingItem(tx, pkg.pickingItemId);
}

/**
 * Finish the order + create the next-step task when every item is fully
 * picked (boxed). Call only after picked_qty is fresh in this tx.
 * The chain is config-aware (FLOW_STEPS_DISABLED): measuring enabled →
 * measuring task; else verify enabled → verify task; else nothing (order
 * finished = ready to ship). The status guard above already keeps a re-close
 * after a verify-time reopen from re-running this for a finished order.
 */
async function maybeAutoFinishPickingOrder(
  tx: DbOrTx,
  a: { pickingOrderId: string; actorId: string | null }
): Promise<boolean> {
  const order = await queryGet<OrderState>(tx, sql`SELECT id, status FROM picking_orders WHERE id = ${a.pickingOrderId}`);
  if (!order) return false;
  if (order.status !== "pending" && order.status !== "picking") return false;
  const items = await queryAll<{ qty: number; pickedQty: number }>(
    tx,
    sql`SELECT qty, picked_qty AS "pickedQty" FROM picking_items WHERE picking_order_id = ${order.id}`
  );
  if (items.length === 0) return false;
  if (!items.every((i) => i.pickedQty >= i.qty)) return false;

  await queryRun(tx, sql`UPDATE picking_orders SET status = 'finished', working_by = NULL, working_at = NULL, last_update_date = ${now()} WHERE id = ${order.id}`);
  if (isStepEnabled("measuring")) {
    await queryRun(
      tx,
      sql`INSERT INTO measuring_tasks (id, picking_order_id, status, created_date)
          VALUES (${newId()}, ${order.id}, 'pending', ${now()})
          ON CONFLICT (picking_order_id) DO NOTHING`
    );
  } else if (isStepEnabled("verify")) {
    await queryRun(
      tx,
      sql`INSERT INTO verify_tasks (id, picking_order_id, status, created_date)
          VALUES (${newId()}, ${order.id}, 'pending', ${now()})
          ON CONFLICT (picking_order_id) DO NOTHING`
    );
  }
  await logTransition(tx, {
    entityType: "picking_order",
    entityId: order.id,
    fromState: order.status,
    toState: "finished",
    actorId: a.actorId,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Whole-box exact-match claim (spec
// docs/superpowers/specs/2026-07-29-whole-box-picking-claim-design.md):
// when a shelf box's CURRENT contents (inventory_lots, box_id set, total_qty
// > 0 — never the shelf_box_items put-away manifest) exactly equal the
// order's full remaining open demand, the operator can claim the whole box in
// one action: the carton is reused as the shipping box (prefilled with the
// box size / net / gross weight from the source receiving lines'
// additional_data), all packages are created boxed, the order's allocations
// are released, and the order auto-finishes like the scan path.
// ---------------------------------------------------------------------------

export interface ShelfBoxMatch {
  id: string;
  shelfCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  contents: { partNo: string; qty: number }[];
}

interface OrderMatchContext {
  id: string;
  customerCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
}

interface BoxLotRow {
  lotId: string;
  boxId: string;
  partNo: string;
  totalQty: number;
  availableQty: number;
  ownAllocQty: number;
  shelfCode: string | null;
  boxOrgId: number | null;
  boxSubInventoryCode: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

/** Open demand per part_no: qty − Σ picking_packages, zero-open parts excluded. */
async function loadOpenDemand(dbOrTx: DbOrTx, orderId: string): Promise<Map<string, number>> {
  const rows = await queryAll<{ partNo: string; openQty: number }>(
    dbOrTx,
    sql`SELECT pi.part_no AS "partNo",
               (pi.qty - COALESCE(pkg.qty, 0))::int AS "openQty"
        FROM picking_items pi
        LEFT JOIN (
          SELECT picking_item_id, SUM(qty)::int AS qty
          FROM picking_packages GROUP BY picking_item_id
        ) pkg ON pkg.picking_item_id = pi.id
        WHERE pi.picking_order_id = ${orderId}`
  );
  const demand = new Map<string, number>();
  for (const r of rows) {
    if (r.openQty <= 0) continue;
    demand.set(r.partNo, (demand.get(r.partNo) ?? 0) + r.openQty);
  }
  return demand;
}

/** Boxed lots visible to the order: location pair + share-group widening +
 *  customer segregation — the same rules allocate.ts applies to lot sources. */
async function loadBoxLots(dbOrTx: DbOrTx, order: OrderMatchContext): Promise<BoxLotRow[]> {
  return queryAll<BoxLotRow>(
    dbOrTx,
    sql`SELECT il.id AS "lotId", il.box_id AS "boxId", il.part_no AS "partNo",
               il.total_qty AS "totalQty", il.available_qty AS "availableQty",
               COALESCE(own.qty, 0)::int AS "ownAllocQty",
               sb.shelf_code AS "shelfCode",
               sb.org_id AS "boxOrgId", sb.sub_inventory_code AS "boxSubInventoryCode",
               il.date_code AS "dateCode", il.lot_code AS "lotCode", il.coo, il.cow
        FROM inventory_lots il
        JOIN shelf_boxes sb ON sb.id = il.box_id
        LEFT JOIN sub_inventories si ON si.org_id = sb.org_id AND si.code = sb.sub_inventory_code
        LEFT JOIN (
          SELECT a.inventory_lot_id, SUM(a.qty)::int AS qty
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          WHERE pi.picking_order_id = ${order.id}
          GROUP BY a.inventory_lot_id
        ) own ON own.inventory_lot_id = il.id
        WHERE il.box_id IS NOT NULL AND il.total_qty > 0
          AND (${order.orgId}::int IS NULL OR sb.org_id = ${order.orgId})
          AND (${order.subInventoryCode}::text IS NULL
               OR sb.sub_inventory_code = ${order.subInventoryCode}
               OR EXISTS (SELECT 1 FROM sub_inventory_share_members sm_d
                          JOIN sub_inventory_share_members sm_s ON sm_s.share_group = sm_d.share_group
                          WHERE sm_d.org_id = ${order.orgId} AND sm_d.code = ${order.subInventoryCode}
                            AND sm_s.org_id = sb.org_id AND sm_s.code = sb.sub_inventory_code))
          AND (si.customer_code IS NULL OR si.customer_code = ${order.customerCode})`
  );
}

interface BoxGroup {
  id: string;
  shelfCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  lots: BoxLotRow[];
  contents: Map<string, number>;
  /** No other order reserves any piece of the box's lots. */
  fullyAvailable: boolean;
}

function groupBoxLots(lots: BoxLotRow[]): BoxGroup[] {
  const byBox = new Map<string, BoxGroup>();
  for (const l of lots) {
    let g = byBox.get(l.boxId);
    if (!g) {
      g = {
        id: l.boxId,
        shelfCode: l.shelfCode,
        orgId: l.boxOrgId,
        subInventoryCode: l.boxSubInventoryCode,
        lots: [],
        contents: new Map(),
        fullyAvailable: true,
      };
      byBox.set(l.boxId, g);
    }
    g.lots.push(l);
    g.contents.set(l.partNo, (g.contents.get(l.partNo) ?? 0) + l.totalQty);
    if (l.availableQty + l.ownAllocQty !== l.totalQty) g.fullyAvailable = false;
  }
  return [...byBox.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mapsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function toShelfBoxMatch(g: BoxGroup): ShelfBoxMatch {
  return {
    id: g.id,
    shelfCode: g.shelfCode,
    orgId: g.orgId,
    subInventoryCode: g.subInventoryCode,
    contents: [...g.contents.entries()].map(([partNo, qty]) => ({ partNo, qty })),
  };
}

/** First fully-claimable box whose contents exactly equal the open demand. */
async function findSuggestedBox(dbOrTx: DbOrTx, order: OrderMatchContext): Promise<ShelfBoxMatch | null> {
  const demand = await loadOpenDemand(dbOrTx, order.id);
  if (demand.size === 0) return null;
  const g = groupBoxLots(await loadBoxLots(dbOrTx, order)).find(
    (g) => g.fullyAvailable && mapsEqual(g.contents, demand)
  );
  return g ? toShelfBoxMatch(g) : null;
}

interface CartonPrefill {
  boxSize: string | null;
  netWeightKg: number | null;
  grossWeightKg: number | null;
}

/** Shipping-box prefill from carton metadata the receiving lines carried in
 *  additional_data ({ boxSize, netWeight, grossWeight, weightUnit: "g" |
 *  "kg" = default }). Weights are summed across source lines, converted to kg
 *  (3 dp); box size is the first non-null. Missing keys → NULL. */
function accumulateCartonPrefill(rows: { ad: unknown }[]): CartonPrefill {
  let boxSize: string | null = null;
  let net = 0;
  let gross = 0;
  let hasNet = false;
  let hasGross = false;
  const num = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  for (const { ad } of rows) {
    if (!ad || typeof ad !== "object") continue;
    const d = ad as Record<string, unknown>;
    const toKg = d.weightUnit === "g" ? 0.001 : 1;
    if (boxSize === null && typeof d.boxSize === "string" && d.boxSize.trim() !== "") boxSize = d.boxSize;
    const nw = d.netWeight == null ? null : num(d.netWeight);
    if (nw !== null) {
      net += nw * toKg;
      hasNet = true;
    }
    const gw = d.grossWeight == null ? null : num(d.grossWeight);
    if (gw !== null) {
      gross += gw * toKg;
      hasGross = true;
    }
  }
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    boxSize,
    netWeightKg: hasNet ? round3(net) : null,
    grossWeightKg: hasGross ? round3(gross) : null,
  };
}

/** Prefill from the source receiving lines of the given lots (whole-box claim). */
async function cartonPrefillFromSources(dbOrTx: DbOrTx, lotIds: string[]): Promise<CartonPrefill> {
  const none: CartonPrefill = { boxSize: null, netWeightKg: null, grossWeightKg: null };
  if (lotIds.length === 0) return none;
  const rows = await queryAll<{ ad: unknown }>(
    dbOrTx,
    sql`SELECT DISTINCT rii.additional_data AS "ad"
        FROM inventory_lot_sources ils
        JOIN receiving_invoice_items rii ON rii.id = ils.receiving_invoice_item_id
        WHERE ${inArray(sql`ils.inventory_lot_id`, lotIds)} AND rii.additional_data IS NOT NULL`
  );
  return accumulateCartonPrefill(rows);
}

/**
 * Pack-path prefill: when a package lands in a shipping box, fill the box's
 * still-NULL box size / net / gross from the receiving lines behind the box's
 * packages — receiving_invoice_item sources directly, lot sources via
 * inventory_lot_sources (order-level receiving sources record no line, so
 * those stay manual). COALESCE only: operator edits are never clobbered, and
 * last_update_date is left alone (derived fill, not an edit).
 */
async function prefillShippingBoxFromSources(tx: DbOrTx, boxId: string): Promise<void> {
  const rows = await queryAll<{ ad: unknown }>(
    tx,
    sql`SELECT rii.additional_data AS "ad"
        FROM picking_packages pp
        JOIN receiving_invoice_items rii ON pp.source_type = 'receiving_invoice_item' AND rii.id = pp.source_id
        WHERE pp.shipping_box_id = ${boxId} AND rii.additional_data IS NOT NULL
        UNION
        SELECT rii.additional_data AS "ad"
        FROM picking_packages pp
        JOIN inventory_lot_sources ils ON pp.source_type = 'inventory_lot' AND ils.inventory_lot_id = pp.source_id
        JOIN receiving_invoice_items rii ON rii.id = ils.receiving_invoice_item_id
        WHERE pp.shipping_box_id = ${boxId} AND rii.additional_data IS NOT NULL`
  );
  const prefill = accumulateCartonPrefill(rows);
  if (prefill.boxSize === null && prefill.netWeightKg === null && prefill.grossWeightKg === null) return;
  await queryRun(
    tx,
    sql`UPDATE shipping_boxes SET
          box_size = COALESCE(box_size, ${prefill.boxSize}),
          net_weight = COALESCE(net_weight, ${prefill.netWeightKg}),
          gross_weight = COALESCE(gross_weight, ${prefill.grossWeightKg})
        WHERE id = ${boxId}`
  );
}

// ---------------------------------------------------------------------------
// Reads (called by the routes; kept here so tests can exercise them).
// ---------------------------------------------------------------------------

export interface PickingOrderListRow {
  id: string;
  orderNo: string;
  status: string;
  allocationStatus: string;
  poNo: string | null;
  shipTo: string | null;
  customerCode: string | null;
  deliveryDate: Date | null;
  orgId: number | null;
  subInventoryCode: string | null;
  prioritySeq: number;
  workingBy: string | null;
  workingByName: string | null;
  itemCount: number;
  totalQty: number;
  pickedQty: number;
  allocatedQty: number;
}

/** List rows with per-order item/qty counts; `status` is a pass-through filter.
 *  Ordered by priority_seq (allocation order, admin-reorderable). */
export async function listPickingOrders(db: AppDb, status?: string): Promise<PickingOrderListRow[]> {
  return queryAll<PickingOrderListRow>(
    db,
    sql`
      SELECT
        po.id, po.order_no AS "orderNo", po.status, po.allocation_status AS "allocationStatus",
        po.po_no AS "poNo", po.ship_to AS "shipTo",
        po.customer_code AS "customerCode",
        po.delivery_date AS "deliveryDate",
        po.org_id AS "orgId", po.sub_inventory_code AS "subInventoryCode",
        po.priority_seq AS "prioritySeq",
        po.working_by AS "workingBy", w.display_name AS "workingByName",
        COUNT(pi.id)::int AS "itemCount",
        COALESCE(SUM(pi.qty), 0)::int AS "totalQty",
        COALESCE(SUM(pi.picked_qty), 0)::int AS "pickedQty",
        COALESCE(SUM(pi.allocated_qty), 0)::int AS "allocatedQty"
      FROM picking_orders po
      LEFT JOIN picking_items pi ON pi.picking_order_id = po.id
      LEFT JOIN users w ON w.id = po.working_by
      ${status ? sql`WHERE po.status = ${status}` : sql``}
      GROUP BY po.id, w.display_name
      ORDER BY po.priority_seq ASC, po.delivery_date ASC NULLS LAST, po.order_no
    `
  );
}

// ---------------------------------------------------------------------------
// Page-driven work lock (design: docs/superpowers/specs/2026-07-23-picking-
// priority-allocation-design.md). A PDA holding the picking order open keeps
// its allocations from being wiped by allocateAll; the lock expires
// WORK_LOCK_TTL_MINUTES after working_at (no cron — compared on acquire and
// at recompute time).
// ---------------------------------------------------------------------------

export interface WorkLockState {
  orderId: string;
  workingBy: string;
}

function lockHeldResponse(holderId: string, holderName: string | null): HTTPException {
  return new HTTPException(409, {
    res: new Response(JSON.stringify({ error: "lock_held", holderId, holderName }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });
}

/** Acquire or refresh the caller's work lock on an open picking order. */
export async function acquireWorkLock(db: AppDb, input: { orderId: string; actorId: string }): Promise<WorkLockState> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string; status: string; workingBy: string | null; workingAt: Date | null }>(
      tx,
      sql`SELECT id, status, working_by AS "workingBy", working_at AS "workingAt"
          FROM picking_orders WHERE id = ${input.orderId}`
    );
    if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });
    if (order.status !== "pending" && order.status !== "picking") {
      throw new HTTPException(409, { message: "picking_order_not_open" });
    }
    const expired = !order.workingBy || !order.workingAt || order.workingAt < workLockExpiry();
    if (order.workingBy && order.workingBy !== input.actorId && !expired) {
      const holder = await queryGet<{ name: string }>(
        tx,
        sql`SELECT display_name AS name FROM users WHERE id = ${order.workingBy}`
      );
      throw lockHeldResponse(order.workingBy, holder?.name ?? null);
    }
    await queryRun(
      tx,
      sql`UPDATE picking_orders SET working_by = ${input.actorId}, working_at = ${now()}, last_update_date = ${now()} WHERE id = ${order.id}`
    );
    return { orderId: order.id, workingBy: input.actorId };
  });
}

/** Best-effort release on page leave; only the holder can release (silent no-op otherwise). */
export async function releaseWorkLock(db: AppDb, input: { orderId: string; actorId: string }): Promise<void> {
  await queryRun(
    db,
    sql`UPDATE picking_orders SET working_by = NULL, working_at = NULL, last_update_date = ${now()}
        WHERE id = ${input.orderId} AND working_by = ${input.actorId}`
  );
}

/** Admin reorder: rewrite priority_seq 1..n for the given open orders, emit the SSE event.
 *  The caller runs allocateAll after commit. */
export async function reorderPickingOrders(
  db: AppDb,
  input: { actorId: string; orderIds: string[] }
): Promise<{ reordered: number }> {
  const ids = [...new Set(input.orderIds)];
  if (ids.length === 0) throw new HTTPException(400, { message: "no_orders" });
  return db.transaction(async (tx) => {
    const rows = await queryAll<{ id: string }>(
      tx,
      sql`SELECT id FROM picking_orders WHERE ${inArray(sql`id`, ids)} AND status IN ('pending', 'picking')`
    );
    if (rows.length !== ids.length) throw new HTTPException(400, { message: "invalid_order_ids" });
    let seq = 1;
    for (const id of ids) {
      await queryRun(tx, sql`UPDATE picking_orders SET priority_seq = ${seq}, last_update_date = ${now()} WHERE id = ${id}`);
      seq += 1;
    }
    await emitEvent(tx, {
      type: "picking.reordered",
      topics: ["/picking-orders"],
      data: { orderIds: ids, actorId: input.actorId },
    });
    return { reordered: ids.length };
  });
}

export interface PickingOrderRow {
  id: string;
  orderNo: string;
  status: string;
  allocationStatus: string;
  deliveryDate: Date | null;
  poNo: string | null;
  shipTo: string | null;
  customerCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  workingBy: string | null;
  workingByName: string | null;
  issueReason: string | null;
  issueQty: number | null;
  issuePackSize: number | null;
  issueNote: string | null;
  issueRemark: string | null;
  issueReportedAt: Date | null;
  issueReportedBy: string | null;
  issueReportedByName: string | null;
  createdDate: Date;
  lastUpdateDate: Date;
}

export interface PickingLotDetail {
  id: string;
  shelfCode: string | null;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

export interface PickingAllocationDetail {
  id: string;
  qty: number;
  lot: PickingLotDetail | null;
  receivingInvoiceItemId: string | null;
  receivingOrderId: string | null;
  boxId: string | null;
}

export interface PickingPackageDetail {
  id: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  verified: boolean;
  verifyVerified: boolean;
  shippingBoxId: string | null;
  sourceType: string;
  sourceId: string;
}

export interface PickingItemDetail {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  pickedQty: number;
  allocatedQty: number;
  lineId: string;
  lineNumber: number;
  shipmentNumber: number;
  status: string;
  allocations: PickingAllocationDetail[];
  packages: PickingPackageDetail[];
}

export interface PickingBoxDetail {
  id: string;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  packageCount: number;
}

export interface PickingOrderDetail extends PickingOrderRow {
  measuringTask: { id: string; status: string } | null;
  items: PickingItemDetail[];
  boxes: PickingBoxDetail[];
  /** Whole-box claim hint: a fully-claimable shelf box whose current contents
   *  exactly equal the order's remaining demand (null when none / not active). */
  suggestedBox: ShelfBoxMatch | null;
}

interface AllocationQueryRow {
  id: string;
  pickingItemId: string;
  qty: number;
  receivingInvoiceItemId: string | null;
  receivingOrderId: string | null;
  boxId: string | null;
  lotId: string | null;
  lotShelfCode: string | null;
  lotBoxId: string | null;
  lotDateCode: string | null;
  lotLotCode: string | null;
  lotCoo: string | null;
  lotCow: string | null;
  lotTotalQty: number | null;
  lotAllocatedQty: number | null;
  lotAvailableQty: number | null;
}

/** Complete nested read: order + measuringTask + items (allocations, packages) + boxes. */
export async function getPickingOrderDetail(db: AppDb, orderId: string): Promise<PickingOrderDetail> {
  const order = await queryGet<PickingOrderRow>(
    db,
    sql`
      SELECT
        po.id, po.order_no AS "orderNo", po.status, po.allocation_status AS "allocationStatus",
        po.delivery_date AS "deliveryDate", po.po_no AS "poNo",
        po.ship_to AS "shipTo",
        po.customer_code AS "customerCode",
        po.org_id AS "orgId", po.sub_inventory_code AS "subInventoryCode",
        po.working_by AS "workingBy", w.display_name AS "workingByName",
        po.issue_reason AS "issueReason", po.issue_qty AS "issueQty", po.issue_pack_size AS "issuePackSize",
        po.issue_note AS "issueNote", po.issue_remark AS "issueRemark",
        po.issue_reported_at AS "issueReportedAt", po.issue_reported_by AS "issueReportedBy",
        ru.display_name AS "issueReportedByName",
        po.created_date AS "createdDate", po.last_update_date AS "lastUpdateDate"
      FROM picking_orders po
      LEFT JOIN users w ON w.id = po.working_by
      LEFT JOIN users ru ON ru.id = po.issue_reported_by
      WHERE po.id = ${orderId}
    `
  );
  if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });

  const measuringTask =
    (await queryGet<{ id: string; status: string }>(
      db,
      sql`SELECT id, status FROM measuring_tasks WHERE picking_order_id = ${orderId}`
    )) ?? null;

  const items = await queryAll<Omit<PickingItemDetail, "allocations" | "packages">>(
    db,
    sql`
      SELECT
        pi.id, pi.part_no AS "partNo", p.wcl_item_no AS "wclItemNo",
        pi.qty, pi.picked_qty AS "pickedQty", pi.allocated_qty AS "allocatedQty",
        pi.line_id AS "lineId", pi.line_number AS "lineNumber",
        pi.shipment_number AS "shipmentNumber", pi.status
      FROM picking_items pi
      JOIN parts p ON p.part_no = pi.part_no
      WHERE pi.picking_order_id = ${orderId}
      ORDER BY pi.created_date, pi.id
    `
  );
  const itemIds = items.map((i) => i.id);

  const allocations = itemIds.length
    ? await queryAll<AllocationQueryRow>(
        db,
        sql`
          SELECT
            a.id, a.picking_item_id AS "pickingItemId", a.qty,
            a.receiving_invoice_item_id AS "receivingInvoiceItemId",
            a.receiving_order_id AS "receivingOrderId",
            rii.ctn_no AS "boxId",
            il.id AS "lotId", il.shelf_code AS "lotShelfCode", il.box_id AS "lotBoxId",
            il.date_code AS "lotDateCode", il.lot_code AS "lotLotCode",
            il.coo AS "lotCoo", il.cow AS "lotCow",
            il.total_qty AS "lotTotalQty", il.allocated_qty AS "lotAllocatedQty",
            il.available_qty AS "lotAvailableQty"
          FROM allocations a
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          WHERE ${inArray(sql`a.picking_item_id`, itemIds)} AND a.qty > 0
          ORDER BY a.created_date, a.id
        `
      )
    : [];

  const packages = itemIds.length
    ? await queryAll<PickingPackageDetail & { pickingItemId: string }>(
        db,
        sql`
          SELECT
            id, picking_item_id AS "pickingItemId", qty,
            date_code AS "dateCode", lot_code AS "lotCode", coo, cow,
            verified, verify_verified AS "verifyVerified", shipping_box_id AS "shippingBoxId",
            source_type AS "sourceType", source_id AS "sourceId"
          FROM picking_packages
          WHERE ${inArray(sql`picking_item_id`, itemIds)}
          ORDER BY created_date, id
        `
      )
    : [];

  const boxes = await queryAll<PickingBoxDetail>(
    db,
    sql`
      SELECT
        sb.id, sb.status, sb.box_size AS "boxSize",
        sb.gross_weight AS "grossWeight", sb.net_weight AS "netWeight",
        sb.destination_country AS "destinationCountry",
        (SELECT COUNT(*)::int FROM picking_packages pp WHERE pp.shipping_box_id = sb.id) AS "packageCount"
      FROM shipping_boxes sb
      WHERE sb.picking_order_id = ${orderId}
      ORDER BY sb.created_date, sb.id
    `
  );

  const suggestedBox =
    order.status === "pending" || order.status === "picking" ? await findSuggestedBox(db, order) : null;

  return {
    ...order,
    measuringTask,
    items: items.map((i) => ({
      ...i,
      allocations: allocations
        .filter((a) => a.pickingItemId === i.id)
        .map((a) => ({
          id: a.id,
          qty: a.qty,
          lot: a.lotId
            ? {
                id: a.lotId,
                shelfCode: a.lotShelfCode,
                boxId: a.lotBoxId,
                dateCode: a.lotDateCode,
                lotCode: a.lotLotCode,
                coo: a.lotCoo,
                cow: a.lotCow,
                totalQty: a.lotTotalQty!,
                allocatedQty: a.lotAllocatedQty!,
                availableQty: a.lotAvailableQty!,
              }
            : null,
          receivingInvoiceItemId: a.receivingInvoiceItemId,
          receivingOrderId: a.receivingOrderId,
          boxId: a.boxId,
        })),
      packages: packages
        .filter((p) => p.pickingItemId === i.id)
        .map(({ pickingItemId: _pickingItemId, ...rest }) => rest),
    })),
    boxes,
    suggestedBox,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface ScanPickingItemInput {
  actorId: string;
  allocationId: string;
  qty: number;
  /** Batch-attr overrides for the created package(s); the source's attrs win
   *  when a field is absent. */
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
}

interface AllocationRow {
  id: string;
  pickingItemId: string;
  qty: number;
  inventoryLotId: string | null;
  receivingInvoiceItemId: string | null;
  receivingOrderId: string | null;
}

interface SourceLine {
  id: string;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

interface PackagePortion extends Omit<SourceLine, "id"> {
  sourceType: "inventory_lot" | "receiving_invoice_item" | "receiving_order";
  sourceId: string;
  qty: number;
  inventoryLotId: string | null;
  shelfCode: string | null;
  receivingInvoiceItemId: string | null;
}

/**
 * Scan qty off an allocation into picking package(s). The allocation's source
 * is consumed per old `scanAllocation` semantics (lot total −qty / receiving
 * picked_qty +qty, allocation shrunk), the batch snapshot rides on the
 * package, and two PICK ledger rows are written per portion. Order-level
 * receiving allocations (new schema) distribute FIFO across the order's lines
 * for the part — one package per consumed portion.
 */
export async function scanPickingItem(
  db: AppDb,
  pickingItemId: string,
  input: ScanPickingItemInput
): Promise<{ packageIds: string[] }> {
  return db.transaction(async (tx) => {
    const item = await queryGet<{ id: string; pickingOrderId: string; partNo: string; qty: number; packagedQty: number }>(
      tx,
      sql`SELECT pi.id, pi.picking_order_id AS "pickingOrderId", pi.part_no AS "partNo", pi.qty,
            COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp WHERE pp.picking_item_id = pi.id), 0) AS "packagedQty"
          FROM picking_items pi WHERE pi.id = ${pickingItemId}`
    );
    if (!item) throw new HTTPException(404, { message: "picking_item_not_found" });
    await assertActor(tx, input.actorId);
    const alloc = await queryGet<AllocationRow>(
      tx,
      sql`SELECT id, picking_item_id AS "pickingItemId", qty,
                 inventory_lot_id AS "inventoryLotId", receiving_invoice_item_id AS "receivingInvoiceItemId",
                 receiving_order_id AS "receivingOrderId"
          FROM allocations WHERE id = ${input.allocationId}`
    );
    if (!alloc || alloc.pickingItemId !== item.id) {
      throw new HTTPException(404, { message: "allocation_not_found" });
    }
    if (!Number.isInteger(input.qty) || input.qty <= 0) {
      throw new HTTPException(400, { message: "qty_must_be_positive_integer" });
    }
    const order = await loadOrderForWrite(tx, item.pickingOrderId);
    assertOrderWritable(order);
    // allocations.qty is the remaining (scans shrink it), so this covers
    // "qty ≤ allocation.qty − already-packaged-from-that-allocation".
    if (input.qty > alloc.qty) throw new HTTPException(409, { message: "scanned_qty_exceeds_allocation" });
    if (item.packagedQty + input.qty > item.qty) {
      throw new HTTPException(409, { message: "scan_qty_exceeds_required" });
    }

    // Consume the source into package portions.
    const portions: PackagePortion[] = [];
    if (alloc.inventoryLotId) {
      const lot = await queryGet<SourceLine & { shelfCode: string | null; totalQty: number }>(
        tx,
        sql`SELECT id, total_qty AS "totalQty", shelf_code AS "shelfCode", box_id AS "boxId",
                   date_code AS "dateCode", lot_code AS "lotCode", coo, cow
            FROM inventory_lots WHERE id = ${alloc.inventoryLotId}`
      );
      if (!lot) throw new HTTPException(404, { message: "inventory_lot_not_found" });
      if (lot.totalQty < input.qty) throw new HTTPException(409, { message: "insufficient_lot_qty" });
      await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = total_qty - ${input.qty} WHERE id = ${lot.id}`);
      if (lot.boxId) await markShelfBoxStockChanged(tx, lot.boxId);
      portions.push({
        sourceType: "inventory_lot",
        sourceId: lot.id,
        qty: input.qty,
        dateCode: lot.dateCode,
        lotCode: lot.lotCode,
        coo: lot.coo,
        cow: lot.cow,
        inventoryLotId: lot.id,
        shelfCode: lot.shelfCode,
        boxId: lot.boxId,
        receivingInvoiceItemId: null,
      });
    } else if (alloc.receivingInvoiceItemId) {
      const rii = await queryGet<SourceLine>(
        tx,
        sql`SELECT id, ctn_no AS "boxId", date_code AS "dateCode", lot_code AS "lotCode", coo, cow
            FROM receiving_invoice_items WHERE id = ${alloc.receivingInvoiceItemId}`
      );
      if (!rii) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
      await queryRun(tx, sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty + ${input.qty} WHERE id = ${rii.id}`);
      portions.push({
        sourceType: "receiving_invoice_item",
        sourceId: rii.id,
        qty: input.qty,
        dateCode: rii.dateCode,
        lotCode: rii.lotCode,
        coo: rii.coo,
        cow: rii.cow,
        inventoryLotId: null,
        shelfCode: null,
        boxId: rii.boxId,
        receivingInvoiceItemId: rii.id,
      });
    } else if (alloc.receivingOrderId) {
      // Order-level source (line without ctn_no): distribute FIFO across the
      // receiving order's lines for the part — the allocation row does not
      // record which line the engine pooled it from.
      const lines = await queryAll<SourceLine & { remaining: number }>(
        tx,
        sql`SELECT rii.id, rii.ctn_no AS "boxId", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
                   rii.coo, rii.cow,
                   (rii.received_qty - rii.picked_qty - rii.put_away_qty)::int AS "remaining"
            FROM receiving_invoice_items rii
            JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
            WHERE ri.receiving_order_id = ${alloc.receivingOrderId} AND rii.part_no = ${item.partNo}
              AND (rii.received_qty - rii.picked_qty - rii.put_away_qty) > 0
            ORDER BY rii.date_code ASC NULLS LAST, rii.id`
      );
      let left = input.qty;
      for (const line of lines) {
        if (left <= 0) break;
        const take = Math.min(line.remaining, left);
        await queryRun(tx, sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty + ${take} WHERE id = ${line.id}`);
        portions.push({
          sourceType: "receiving_order",
          sourceId: alloc.receivingOrderId,
          qty: take,
          dateCode: line.dateCode,
          lotCode: line.lotCode,
          coo: line.coo,
          cow: line.cow,
          inventoryLotId: null,
          shelfCode: null,
          boxId: line.boxId,
          receivingInvoiceItemId: line.id,
        });
        left -= take;
      }
      if (left > 0) throw new HTTPException(409, { message: "receiving_source_qty_not_available" });
    } else {
      throw new HTTPException(409, { message: "allocation_has_no_source" });
    }

    await reduceAllocation(tx, alloc.id, input.qty);

    // Package rows (batch snapshot = source attrs, explicit body fields win) +
    // two PICK ledger rows per portion (reserved −qty / on_hand −qty).
    const at = now();
    const packageIds: string[] = [];
    const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
    for (const p of portions) {
      const pid = newId();
      const dateCode = input.dateCode ?? p.dateCode;
      const lotCode = input.lotCode ?? p.lotCode;
      const coo = input.coo ?? p.coo;
      const cow = input.cow ?? p.cow;
      await queryRun(
        tx,
        sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty,
                                         shipping_box_id, date_code, lot_code, coo, cow, created_date, last_update_date)
            VALUES (${pid}, ${item.id}, ${item.pickingOrderId}, ${p.sourceType}, ${p.sourceId}, ${p.qty}, NULL,
                    ${dateCode}, ${lotCode}, ${coo}, ${cow}, ${at}, ${at})`
      );
      packageIds.push(pid);
      const base = {
        inventoryLotId: p.inventoryLotId,
        partNo: item.partNo,
        shelfCode: p.shelfCode,
        boxId: p.boxId,
        txnType: "PICK",
        dateCode,
        lotCode,
        coo,
        cow,
        referenceType: "picking_item",
        referenceId: item.id,
        receivingInvoiceItemId: p.receivingInvoiceItemId,
        actorId: input.actorId,
        txnReason: "pick",
        txnAt: at,
      };
      txnRows.push(
        { ...base, id: newId(), qtyType: "reserved", qtyDelta: -p.qty },
        { ...base, id: newId(), qtyType: "on_hand", qtyDelta: -p.qty }
      );
    }
    await tx.insert(inventoryTransactions).values(txnRows);

    if (order.status === "pending") {
      await queryRun(tx, sql`UPDATE picking_orders SET status = 'picking', last_update_date = ${at} WHERE id = ${order.id}`);
      await logTransition(tx, {
        entityType: "picking_order",
        entityId: order.id,
        fromState: "pending",
        toState: "picking",
        actorId: input.actorId,
      });
    }
    await logTransition(tx, {
      entityType: "picking_item",
      entityId: item.id,
      fromState: "picking",
      toState: "scanned",
      actorId: input.actorId,
      metadata: { qty: input.qty, allocation: alloc.id },
    });

    await recomputePickingItem(tx, item.id);
    await maybeAutoFinishPickingOrder(tx, { pickingOrderId: item.pickingOrderId, actorId: input.actorId });
    return { packageIds };
  });
}

/**
 * Whole-box exact-match claim: the shelf box's current contents must exactly
 * equal the order's full remaining open demand (409 box_not_exact_match) and
 * no other order may reserve any piece of it (409 box_not_fully_available).
 * The carton is reused as the shipping box (prefilled from the source
 * receiving lines' additional_data, source_shelf_box_id recorded), one boxed
 * package per (item, lot) portion, the order's allocations are released
 * (work-locked orders are skipped by allocateAll, so the tx cleans up
 * itself), and the auto-finish chain runs like the scan path.
 */
export async function claimShelfBox(
  db: AppDb,
  input: { orderId: string; shelfBoxId: string; actorId: string }
): Promise<{ shippingBoxId: string; packageIds: string[] }> {
  return db.transaction(async (tx) => {
    const order = await queryGet<OrderMatchContext & { status: string }>(
      tx,
      sql`SELECT id, status, customer_code AS "customerCode",
                 org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
          FROM picking_orders WHERE id = ${input.orderId}`
    );
    if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });
    assertOrderWritable(order);
    await assertActor(tx, input.actorId);
    const box = await queryGet<{ id: string }>(tx, sql`SELECT id FROM shelf_boxes WHERE id = ${input.shelfBoxId}`);
    if (!box) throw new HTTPException(404, { message: "shelf_box_not_found" });

    const demand = await loadOpenDemand(tx, order.id);
    const group = groupBoxLots(await loadBoxLots(tx, order)).find((g) => g.id === box.id);
    if (!group || !mapsEqual(group.contents, demand)) {
      throw new HTTPException(409, { message: "box_not_exact_match" });
    }
    if (!group.fullyAvailable) throw new HTTPException(409, { message: "box_not_fully_available" });

    const prefill = await cartonPrefillFromSources(tx, group.lots.map((l) => l.lotId));

    const at = now();
    const shippingBoxId = await nextBoxId(tx, "S");
    await queryRun(
      tx,
      sql`INSERT INTO shipping_boxes (id, picking_order_id, status, box_size, net_weight, gross_weight,
                                     source_shelf_box_id, created_date, last_update_date)
          VALUES (${shippingBoxId}, ${order.id}, 'open', ${prefill.boxSize}, ${prefill.netWeightKg},
                  ${prefill.grossWeightKg}, ${box.id}, ${at}, ${at})`
    );
    await logTransition(tx, {
      entityType: "shipping_box",
      entityId: shippingBoxId,
      fromState: null,
      toState: "open",
      actorId: input.actorId,
      metadata: { picking_order: order.id, source_shelf_box: box.id },
    });

    // Open items per part (exact match ⇒ Σ lot qty per part == Σ open qty per
    // part; distribute lot qty FIFO across the part's items, like the
    // order-level receiving source does across lines).
    const openItems = await queryAll<{ id: string; partNo: string; openQty: number }>(
      tx,
      sql`SELECT pi.id, pi.part_no AS "partNo",
                 (pi.qty - COALESCE(pkg.qty, 0))::int AS "openQty"
          FROM picking_items pi
          LEFT JOIN (
            SELECT picking_item_id, SUM(qty)::int AS qty
            FROM picking_packages GROUP BY picking_item_id
          ) pkg ON pkg.picking_item_id = pi.id
          WHERE pi.picking_order_id = ${order.id}
          ORDER BY pi.created_date, pi.id`
    );
    const openLeft = new Map(openItems.map((i) => [i.id, i.openQty]));
    const itemsByPart = new Map<string, { id: string }[]>();
    for (const i of openItems) {
      const list = itemsByPart.get(i.partNo) ?? [];
      list.push({ id: i.id });
      itemsByPart.set(i.partNo, list);
    }

    const packageIds: string[] = [];
    const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
    for (const lot of group.lots) {
      await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = 0, last_update_date = ${at} WHERE id = ${lot.lotId}`);
      let left = lot.totalQty;
      for (const item of itemsByPart.get(lot.partNo) ?? []) {
        if (left <= 0) break;
        const take = Math.min(openLeft.get(item.id) ?? 0, left);
        if (take <= 0) continue;
        openLeft.set(item.id, (openLeft.get(item.id) ?? 0) - take);
        left -= take;
        const pid = newId();
        await queryRun(
          tx,
          sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty,
                                           shipping_box_id, date_code, lot_code, coo, cow, created_date, last_update_date)
              VALUES (${pid}, ${item.id}, ${order.id}, 'inventory_lot', ${lot.lotId}, ${take}, ${shippingBoxId},
                      ${lot.dateCode}, ${lot.lotCode}, ${lot.coo}, ${lot.cow}, ${at}, ${at})`
        );
        packageIds.push(pid);
        txnRows.push({
          id: newId(),
          inventoryLotId: lot.lotId,
          partNo: lot.partNo,
          shelfCode: lot.shelfCode,
          boxId: lot.boxId,
          txnType: "PICK",
          qtyType: "on_hand",
          qtyDelta: -take,
          dateCode: lot.dateCode,
          lotCode: lot.lotCode,
          coo: lot.coo,
          cow: lot.cow,
          referenceType: "picking_item",
          referenceId: item.id,
          receivingInvoiceItemId: null,
          actorId: input.actorId,
          txnReason: "whole-box claim",
          txnAt: at,
        });
      }
    }

    // Release every allocation of the order's items (RESERVE reserved −qty
    // ledger rows, allocate.ts "recompute: release" shape) and free the lots.
    const released = await queryAll<{
      id: string;
      qty: number;
      inventoryLotId: string | null;
      partNo: string;
      shelfCode: string | null;
      boxId: string | null;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      receivingInvoiceItemId: string | null;
    }>(
      tx,
      sql`SELECT a.id, a.qty, a.inventory_lot_id AS "inventoryLotId",
                 pi.part_no AS "partNo",
                 il.shelf_code AS "shelfCode", COALESCE(il.box_id, rii.ctn_no) AS "boxId",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode",
                 COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS "coo", COALESCE(il.cow, rii.cow) AS "cow",
                 a.receiving_invoice_item_id AS "receivingInvoiceItemId"
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          WHERE pi.picking_order_id = ${order.id} AND a.qty > 0`
    );
    await queryRun(
      tx,
      sql`DELETE FROM allocations WHERE picking_item_id IN (
            SELECT id FROM picking_items WHERE picking_order_id = ${order.id})`
    );
    const freedLots = new Set<string>();
    for (const a of released) {
      if (a.inventoryLotId) freedLots.add(a.inventoryLotId);
      txnRows.push({
        id: newId(),
        inventoryLotId: a.inventoryLotId,
        partNo: a.partNo,
        shelfCode: a.shelfCode,
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
        actorId: input.actorId,
        txnReason: "whole-box claim: release",
        txnAt: at,
      });
    }
    for (const lotId of freedLots) await recomputeLot(tx, lotId);
    await tx.insert(inventoryTransactions).values(txnRows);

    await markShelfBoxStockChanged(tx, box.id);
    for (const i of openItems) await recomputePickingItem(tx, i.id);
    await maybeAutoFinishPickingOrder(tx, { pickingOrderId: order.id, actorId: input.actorId });
    return { shippingBoxId, packageIds };
  });
}

/**
 * Remove an unboxed, unverified package: reverse the source consumption
 * (lot total +qty / receiving picked_qty −qty), restore the allocation, write
 * the reverse PICK ledger rows, and delete the package. Order-level sources
 * are credited back across the order's lines reverse-FIFO (last-consumed
 * first — the package does not record which line each portion came from).
 */
export async function removeScannedPackage(db: AppDb, input: { packageId: string; actorId: string }): Promise<void> {
  return db.transaction(async (tx) => {
    const pkg = await queryGet<{
      id: string;
      pickingItemId: string;
      pickingOrderId: string;
      partNo: string;
      sourceType: string;
      sourceId: string;
      qty: number;
      shippingBoxId: string | null;
      verified: boolean;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
    }>(
      tx,
      sql`SELECT pp.id, pp.picking_item_id AS "pickingItemId", pi.picking_order_id AS "pickingOrderId",
                 pi.part_no AS "partNo",
                 pp.source_type AS "sourceType", pp.source_id AS "sourceId", pp.qty,
                 pp.shipping_box_id AS "shippingBoxId", pp.verified,
                 pp.date_code AS "dateCode", pp.lot_code AS "lotCode", pp.coo, pp.cow
          FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id
          WHERE pp.id = ${input.packageId}`
    );
    if (!pkg) throw new HTTPException(404, { message: "package_not_found" });
    if (pkg.shippingBoxId !== null) throw new HTTPException(409, { message: "package_already_in_box" });
    if (pkg.verified) throw new HTTPException(409, { message: "package_already_verified" });
    await assertActor(tx, input.actorId);
    const order = await loadOrderForWrite(tx, pkg.pickingOrderId);
    assertOrderWritable(order);

    const at = now();
    const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
    const base = {
      partNo: pkg.partNo,
      txnType: "PICK",
      dateCode: pkg.dateCode,
      lotCode: pkg.lotCode,
      coo: pkg.coo,
      cow: pkg.cow,
      referenceType: "picking_item",
      referenceId: pkg.pickingItemId,
      actorId: input.actorId,
      txnReason: "remove package",
      txnAt: at,
    };

    if (pkg.sourceType === "inventory_lot") {
      const lot = await queryGet<{ id: string; shelfCode: string | null; boxId: string | null }>(
        tx,
        sql`SELECT id, shelf_code AS "shelfCode", box_id AS "boxId" FROM inventory_lots WHERE id = ${pkg.sourceId}`
      );
      if (!lot) throw new HTTPException(404, { message: "inventory_lot_not_found" });
      await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = total_qty + ${pkg.qty} WHERE id = ${lot.id}`);
      if (lot.boxId) await markShelfBoxStockChanged(tx, lot.boxId);
      await bumpAllocation(tx, { pickingItemId: pkg.pickingItemId, qty: pkg.qty, inventoryLotId: lot.id });
      txnRows.push(
        { ...base, id: newId(), inventoryLotId: lot.id, shelfCode: lot.shelfCode, boxId: lot.boxId, receivingInvoiceItemId: null, qtyType: "reserved", qtyDelta: pkg.qty },
        { ...base, id: newId(), inventoryLotId: lot.id, shelfCode: lot.shelfCode, boxId: lot.boxId, receivingInvoiceItemId: null, qtyType: "on_hand", qtyDelta: pkg.qty }
      );
    } else if (pkg.sourceType === "receiving_invoice_item") {
      const rii = await queryGet<{ id: string; boxId: string | null }>(
        tx,
        sql`SELECT id, ctn_no AS "boxId" FROM receiving_invoice_items WHERE id = ${pkg.sourceId}`
      );
      if (!rii) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
      await queryRun(tx, sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty - ${pkg.qty} WHERE id = ${rii.id}`);
      await bumpAllocation(tx, { pickingItemId: pkg.pickingItemId, qty: pkg.qty, receivingInvoiceItemId: rii.id });
      txnRows.push(
        { ...base, id: newId(), inventoryLotId: null, shelfCode: null, boxId: rii.boxId, receivingInvoiceItemId: rii.id, qtyType: "reserved", qtyDelta: pkg.qty },
        { ...base, id: newId(), inventoryLotId: null, shelfCode: null, boxId: rii.boxId, receivingInvoiceItemId: rii.id, qtyType: "on_hand", qtyDelta: pkg.qty }
      );
    } else if (pkg.sourceType === "receiving_order") {
      const lines = await queryAll<{ id: string; pickedQty: number; boxId: string | null }>(
        tx,
        sql`SELECT rii.id, rii.picked_qty AS "pickedQty", rii.ctn_no AS "boxId"
            FROM receiving_invoice_items rii
            JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
            WHERE ri.receiving_order_id = ${pkg.sourceId} AND rii.part_no = ${pkg.partNo} AND rii.picked_qty > 0
            ORDER BY rii.date_code DESC NULLS FIRST, rii.id DESC`
      );
      let left = pkg.qty;
      for (const line of lines) {
        if (left <= 0) break;
        const give = Math.min(line.pickedQty, left);
        await queryRun(tx, sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty - ${give} WHERE id = ${line.id}`);
        txnRows.push(
          { ...base, id: newId(), inventoryLotId: null, shelfCode: null, boxId: line.boxId, receivingInvoiceItemId: line.id, qtyType: "reserved", qtyDelta: give },
          { ...base, id: newId(), inventoryLotId: null, shelfCode: null, boxId: line.boxId, receivingInvoiceItemId: line.id, qtyType: "on_hand", qtyDelta: give }
        );
        left -= give;
      }
      if (left > 0) throw new HTTPException(409, { message: "receiving_source_qty_not_available" });
      await bumpAllocation(tx, { pickingItemId: pkg.pickingItemId, qty: pkg.qty, receivingOrderId: pkg.sourceId });
    } else {
      throw new HTTPException(409, { message: "unknown_package_source_type" });
    }

    await queryRun(tx, sql`DELETE FROM picking_packages WHERE id = ${pkg.id}`);
    if (txnRows.length > 0) await tx.insert(inventoryTransactions).values(txnRows);
    await recomputePickingItem(tx, pkg.pickingItemId);
    await logTransition(tx, {
      entityType: "picking_item",
      entityId: pkg.pickingItemId,
      fromState: "scanned",
      toState: "removed",
      actorId: input.actorId,
      metadata: { qty: pkg.qty, package: pkg.id },
    });
  });
}

/**
 * Verify-scan a package. Branching on the order's pending task:
 *  - pending measuring task → the box must be open; sets `verified`.
 *  - else pending verify task → the box may be open OR closed (verifying
 *    parts against a sealed box is the normal verify pass); sets
 *    `verify_verified` AND `verified` (so a reopened box can re-close).
 * 409 `package_already_verified` only when the applicable flag is already set.
 */
export async function verifyPackage(db: AppDb, input: { packageId: string; actorId: string }): Promise<void> {
  return db.transaction(async (tx) => {
    const pkg = await queryGet<{
      id: string;
      shippingBoxId: string | null;
      verified: boolean;
      verifyVerified: boolean;
      qty: number;
      pickingOrderId: string;
    }>(
      tx,
      sql`SELECT pp.id, pp.shipping_box_id AS "shippingBoxId", pp.verified,
                 pp.verify_verified AS "verifyVerified", pp.qty,
                 pi.picking_order_id AS "pickingOrderId"
          FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${input.packageId}`
    );
    if (!pkg) throw new HTTPException(404, { message: "package_not_found" });
    if (pkg.shippingBoxId === null) throw new HTTPException(409, { message: "package_not_in_box" });
    await assertActor(tx, input.actorId);
    const box = await loadShippingBox(tx, pkg.shippingBoxId);
    const measuringTask = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM measuring_tasks WHERE picking_order_id = ${pkg.pickingOrderId} AND status = 'pending'`
    );
    if (measuringTask) {
      if (box.status !== "open") throw new HTTPException(409, { message: "shipping_box_not_open" });
      if (pkg.verified) throw new HTTPException(409, { message: "package_already_verified" });
      await queryRun(tx, sql`UPDATE picking_packages SET verified = true, last_update_date = ${now()} WHERE id = ${pkg.id}`);
      await logTransition(tx, {
        entityType: "picking_package",
        entityId: pkg.id,
        fromState: "unverified",
        toState: "verified",
        actorId: input.actorId,
        metadata: { qty: pkg.qty, box: box.id },
      });
      return;
    }
    const verifyTask = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM verify_tasks WHERE picking_order_id = ${pkg.pickingOrderId} AND status = 'pending'`
    );
    if (!verifyTask) throw new HTTPException(409, { message: "no_pending_measure_or_verify_task" });
    if (pkg.verifyVerified) throw new HTTPException(409, { message: "package_already_verified" });
    await queryRun(
      tx,
      sql`UPDATE picking_packages SET verified = true, verify_verified = true, last_update_date = ${now()} WHERE id = ${pkg.id}`
    );
    await logTransition(tx, {
      entityType: "picking_package",
      entityId: pkg.id,
      fromState: "verified",
      toState: "verify_verified",
      actorId: input.actorId,
      metadata: { qty: pkg.qty, box: box.id },
    });
  });
}

export interface ShippingBoxDto {
  id: string;
  pickingOrderId: string | null;
  status: string;
  boxSize: string | null;
  netWeight: number | null;
  grossWeight: number | null;
  destinationCountry: string | null;
  createdDate: Date;
}

function toBoxDto(box: ShippingBoxRow): ShippingBoxDto {
  return {
    id: box.id,
    pickingOrderId: box.pickingOrderId,
    status: box.status,
    boxSize: box.boxSize,
    netWeight: box.netWeight,
    grossWeight: box.grossWeight,
    destinationCountry: box.destinationCountry,
    createdDate: box.createdDate,
  };
}

/** Create an open shipping box for the order (+ transition log). A pre-printed
 *  `boxId` may be supplied (scanned box label); it is the global PK, so a
 *  duplicate is rejected with 409 box_id_exists. Server-generated ids follow
 *  nextBoxId: BOX-S-<YYYYMMDD>-<seq> (per-day seq). */
export async function createShippingBox(
  db: AppDb,
  input: { pickingOrderId: string; actorId: string; boxId?: string }
): Promise<ShippingBoxDto> {
  return db.transaction(async (tx) => {
    const order = await loadOrderForWrite(tx, input.pickingOrderId);
    assertOrderWritable(order);
    await assertActor(tx, input.actorId);
    const requested = input.boxId?.trim();
    if (requested !== undefined && requested === "") {
      throw new HTTPException(400, { message: "box_id_empty" });
    }
    const id = requested || (await nextBoxId(tx, "S"));
    if (requested) {
      const dup = await queryGet<{ id: string }>(
        tx,
        sql`SELECT id FROM shipping_boxes WHERE id = ${id}`
      );
      if (dup) throw new HTTPException(409, { message: "box_id_exists" });
    }
    const at = now();
    await queryRun(
      tx,
      sql`INSERT INTO shipping_boxes (id, picking_order_id, status, created_date, last_update_date)
          VALUES (${id}, ${input.pickingOrderId}, 'open', ${at}, ${at})`
    );
    await logTransition(tx, {
      entityType: "shipping_box",
      entityId: id,
      fromState: null,
      toState: "open",
      actorId: input.actorId,
      metadata: { picking_order: input.pickingOrderId },
    });
    return {
      id,
      pickingOrderId: input.pickingOrderId,
      status: "open",
      boxSize: null,
      netWeight: null,
      grossWeight: null,
      destinationCountry: null,
      createdDate: at,
    };
  });
}

/** undefined = leave unchanged; null/"" = clear; otherwise parsed/trimmed value. */
function cleanText(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Kilograms, one unit everywhere; decimals allowed, rounded to 3 dp, stored into the REAL weight columns. */
function parseKg(v: number | string | null | undefined, message: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HTTPException(400, { message });
  return Math.round(n * 1000) / 1000;
}

/** Edit box size / weights (kg) / destination country; open boxes only. */
export async function updateShippingBox(
  db: AppDb,
  boxId: string,
  input: {
    actorId: string;
    boxSize?: string | null;
    netWeightKg?: number | string | null;
    grossWeightKg?: number | string | null;
    destinationCountry?: string | null;
  }
): Promise<ShippingBoxDto> {
  return db.transaction(async (tx) => {
    const box = await loadShippingBox(tx, boxId);
    await assertActor(tx, input.actorId);
    if (box.status !== "open") throw new HTTPException(409, { message: "shipping_box_not_open" });
    const size = cleanText(input.boxSize);
    const net = parseKg(input.netWeightKg, "invalid_net_weight_kg");
    const gross = parseKg(input.grossWeightKg, "invalid_gross_weight_kg");
    const dest = cleanText(input.destinationCountry);
    await queryRun(
      tx,
      sql`UPDATE shipping_boxes SET
            box_size = ${size === undefined ? box.boxSize : size},
            net_weight = ${net === undefined ? box.netWeight : net},
            gross_weight = ${gross === undefined ? box.grossWeight : gross},
            destination_country = ${dest === undefined ? box.destinationCountry : dest},
            last_update_date = ${now()}
          WHERE id = ${box.id}`
    );
    return toBoxDto(await loadShippingBox(tx, boxId));
  });
}

/** Add one unboxed package of the box's order into an open box (+ auto-finish check). */
export async function addPackageToBox(
  db: AppDb,
  input: { shippingBoxId: string; packageId: string; actorId: string }
): Promise<void> {
  return db.transaction(async (tx) => {
    const pkg = await queryGet<{ id: string; pickingItemId: string; pickingOrderId: string; shippingBoxId: string | null; qty: number }>(
      tx,
      sql`SELECT pp.id, pp.picking_item_id AS "pickingItemId", pi.picking_order_id AS "pickingOrderId",
                 pp.shipping_box_id AS "shippingBoxId", pp.qty
          FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${input.packageId}`
    );
    if (!pkg) throw new HTTPException(404, { message: "package_not_found" });
    if (pkg.shippingBoxId !== null) throw new HTTPException(409, { message: "package_already_in_box" });
    await assertActor(tx, input.actorId);
    const box = await loadShippingBox(tx, input.shippingBoxId);
    if (box.status !== "open") throw new HTTPException(409, { message: "shipping_box_not_open" });
    if (box.pickingOrderId !== pkg.pickingOrderId) {
      throw new HTTPException(409, { message: "different_picking_orders" });
    }
    const order = await loadOrderForWrite(tx, pkg.pickingOrderId);
    assertOrderWritable(order);

    await assignPackageToBoxTx(tx, pkg.id, box.id);
    await prefillShippingBoxFromSources(tx, box.id);
    await logTransition(tx, {
      entityType: "picking_item",
      entityId: pkg.pickingItemId,
      fromState: "scanned",
      toState: "boxed",
      actorId: input.actorId,
      metadata: { qty: pkg.qty, box: box.id },
    });
    await maybeAutoFinishPickingOrder(tx, { pickingOrderId: pkg.pickingOrderId, actorId: input.actorId });
  });
}

/** Add every unboxed package of the box's order into the box → {packed}. */
export async function addAllUnboxedToShippingBox(
  db: AppDb,
  input: { shippingBoxId: string; actorId: string }
): Promise<{ packed: number }> {
  return db.transaction(async (tx) => {
    const box = await loadShippingBox(tx, input.shippingBoxId);
    await assertActor(tx, input.actorId);
    if (box.status !== "open") throw new HTTPException(409, { message: "shipping_box_not_open" });
    const order = await loadOrderForWrite(tx, box.pickingOrderId!);
    assertOrderWritable(order);
    const packages = await queryAll<{ id: string; pickingItemId: string; qty: number }>(
      tx,
      sql`SELECT pp.id, pp.picking_item_id AS "pickingItemId", pp.qty
          FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id
          WHERE pi.picking_order_id = ${box.pickingOrderId} AND pp.shipping_box_id IS NULL
          ORDER BY pp.created_date ASC, pp.id ASC`
    );
    for (const pkg of packages) {
      await assignPackageToBoxTx(tx, pkg.id, box.id);
      await logTransition(tx, {
        entityType: "picking_item",
        entityId: pkg.pickingItemId,
        fromState: "scanned",
        toState: "boxed",
        actorId: input.actorId,
        metadata: { qty: pkg.qty, box: box.id },
      });
    }
    await prefillShippingBoxFromSources(tx, box.id);
    await maybeAutoFinishPickingOrder(tx, { pickingOrderId: order.id, actorId: input.actorId });
    return { packed: packages.length };
  });
}

/**
 * Remove a package from its box (back to scanned-unboxed; the verified flag
 * is cleared like the old code). Only 'issue' orders are blocked — unpacking
 * a finished order is allowed as a measuring-time correction.
 */
export async function removePackageFromBox(
  db: AppDb,
  input: { shippingBoxId: string; packageId: string; actorId: string }
): Promise<void> {
  return db.transaction(async (tx) => {
    const pkg = await queryGet<{ id: string; pickingItemId: string; pickingOrderId: string; shippingBoxId: string | null; qty: number }>(
      tx,
      sql`SELECT pp.id, pp.picking_item_id AS "pickingItemId", pi.picking_order_id AS "pickingOrderId",
                 pp.shipping_box_id AS "shippingBoxId", pp.qty
          FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${input.packageId}`
    );
    if (!pkg || pkg.shippingBoxId !== input.shippingBoxId) {
      throw new HTTPException(404, { message: "package_not_found" });
    }
    await assertActor(tx, input.actorId);
    const box = await loadShippingBox(tx, input.shippingBoxId);
    if (box.status !== "open") throw new HTTPException(409, { message: "shipping_box_not_open" });
    const order = await loadOrderForWrite(tx, pkg.pickingOrderId);
    if (order.status === "issue") throw new HTTPException(409, { message: "picking_order_has_open_issue" });

    await unassignPackageFromBoxTx(tx, pkg.id);
    await logTransition(tx, {
      entityType: "picking_item",
      entityId: pkg.pickingItemId,
      fromState: "boxed",
      toState: "scanned",
      actorId: input.actorId,
      metadata: { qty: pkg.qty, box: box.id },
    });
  });
}

/** Cancel an empty, open shipping box: transition log + hard delete. */
export async function cancelShippingBox(db: AppDb, input: { shippingBoxId: string; actorId: string }): Promise<void> {
  return db.transaction(async (tx) => {
    const box = await loadShippingBox(tx, input.shippingBoxId);
    await assertActor(tx, input.actorId);
    if (box.status !== "open") throw new HTTPException(409, { message: "shipping_box_not_open" });
    const used = (
      await queryGet<{ c: number }>(tx, sql`SELECT COUNT(*)::int AS c FROM picking_packages WHERE shipping_box_id = ${box.id}`)
    )!.c;
    if (used > 0) throw new HTTPException(409, { message: "shipping_box_not_empty" });
    await logTransition(tx, {
      entityType: "shipping_box",
      entityId: box.id,
      fromState: box.status,
      toState: "cancelled",
      actorId: input.actorId,
      metadata: { picking_order: box.pickingOrderId },
    });
    await queryRun(tx, sql`DELETE FROM shipping_boxes WHERE id = ${box.id}`);
  });
}

/**
 * Close a shipping box (ported from measure.ts): non-empty, all packages
 * verified, destination (box → order ship_to), box
 * size, and positive weights with gross ≥ net are required. Stamps the
 * resolved destination, logs the transition, and runs the auto-finish check.
 * Auto-complete chain: when this was the order's last open box and nothing is
 * left unboxed, a pending measuring task completes itself (which spawns the
 * verify task when the verify step is enabled).
 */
export async function closeShippingBox(db: AppDb, input: { shippingBoxId: string; actorId: string }): Promise<void> {
  return db.transaction(async (tx) => {
    const box = await loadShippingBox(tx, input.shippingBoxId);
    await assertActor(tx, input.actorId);
    if (box.status !== "open") throw new HTTPException(409, { message: "shipping_box_not_open" });
    const pkgs = await queryAll<{ id: string; verified: boolean }>(
      tx,
      sql`SELECT id, verified FROM picking_packages WHERE shipping_box_id = ${box.id}`
    );
    if (pkgs.length === 0) throw new HTTPException(409, { message: "cannot_close_empty_shipping_box" });
    if (pkgs.some((p) => !p.verified)) throw new HTTPException(409, { message: "all_packages_must_be_verified" });

    let dest = box.destinationCountry;
    if (dest === null || dest.trim() === "") {
      const order = await queryGet<{ st: string | null }>(
        tx,
        sql`SELECT ship_to AS st FROM picking_orders WHERE id = ${box.pickingOrderId}`
      );
      dest = order?.st ?? null;
    }
    if (dest === null || dest.trim() === "") throw new HTTPException(409, { message: "destination_required" });
    if (box.boxSize === null || box.boxSize.trim() === "") throw new HTTPException(409, { message: "box_size_required" });
    if (box.netWeight === null || box.grossWeight === null) throw new HTTPException(409, { message: "weights_required" });
    if (box.netWeight <= 0 || box.grossWeight <= 0) throw new HTTPException(409, { message: "weights_must_be_positive" });
    if (box.grossWeight < box.netWeight) throw new HTTPException(409, { message: "gross_weight_must_be_gte_net_weight" });

    await queryRun(
      tx,
      sql`UPDATE shipping_boxes SET status = 'closed', destination_country = ${dest}, last_update_date = ${now()} WHERE id = ${box.id}`
    );
    await logTransition(tx, {
      entityType: "shipping_box",
      entityId: box.id,
      fromState: "open",
      toState: "closed",
      actorId: input.actorId,
    });
    if (box.pickingOrderId) {
      await maybeAutoFinishPickingOrder(tx, { pickingOrderId: box.pickingOrderId, actorId: input.actorId });
      // Auto-complete chain: a pending measuring task completes once every
      // box of the order is closed and no package is left unboxed.
      const pendingMeasuring = await queryGet<{ id: string }>(
        tx,
        sql`SELECT id FROM measuring_tasks WHERE picking_order_id = ${box.pickingOrderId} AND status = 'pending'`
      );
      if (pendingMeasuring) {
        const openBox = await queryGet<{ id: string }>(
          tx,
          sql`SELECT id FROM shipping_boxes WHERE picking_order_id = ${box.pickingOrderId} AND status <> 'closed' LIMIT 1`
        );
        const unboxed = await queryGet<{ id: string }>(
          tx,
          sql`SELECT id FROM picking_packages WHERE picking_order_id = ${box.pickingOrderId} AND shipping_box_id IS NULL LIMIT 1`
        );
        if (!openBox && !unboxed) {
          await completeMeasuringTaskTx(tx, { taskId: pendingMeasuring.id, actorId: input.actorId });
        }
      }
    }
  });
}

/**
 * Explicit finish: all items fully picked (boxed) → order 'finished' + the
 * next-step task (measuring, or verify when measuring is disabled — unique
 * per order). Returns the created task, or null when both steps are off.
 */
export async function finishPickingOrder(
  db: AppDb,
  input: { pickingOrderId: string; actorId: string }
): Promise<{ id: string; pickingOrderId: string; status: string } | null> {
  return db.transaction(async (tx) => {
    const order = await loadOrderForWrite(tx, input.pickingOrderId);
    assertOrderWritable(order);
    await assertActor(tx, input.actorId);
    const existingTask = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM measuring_tasks WHERE picking_order_id = ${order.id}
          UNION ALL SELECT id FROM verify_tasks WHERE picking_order_id = ${order.id} LIMIT 1`
    );
    if (existingTask) throw new HTTPException(409, { message: "measuring_task_exists" });
    const items = await queryAll<{ qty: number; pickedQty: number }>(
      tx,
      sql`SELECT qty, picked_qty AS "pickedQty" FROM picking_items WHERE picking_order_id = ${order.id}`
    );
    if (items.length === 0) throw new HTTPException(409, { message: "no_items_to_pick" });
    if (!items.every((i) => i.pickedQty >= i.qty)) {
      throw new HTTPException(409, { message: "not_all_items_fully_boxed" });
    }
    const done = await maybeAutoFinishPickingOrder(tx, { pickingOrderId: order.id, actorId: input.actorId });
    if (!done) throw new HTTPException(409, { message: "picking_order_could_not_be_finished" });
    const task = await queryGet<{ id: string; pickingOrderId: string; status: string }>(
      tx,
      sql`SELECT id, picking_order_id AS "pickingOrderId", status FROM measuring_tasks WHERE picking_order_id = ${order.id}
          UNION ALL
          SELECT id, picking_order_id AS "pickingOrderId", status FROM verify_tasks WHERE picking_order_id = ${order.id}
          LIMIT 1`
    );
    return task ?? null;
  });
}

/**
 * Reopen a closed shipping box during the verify step: the order must have a
 * pending verify task (reopen is a verify-step action only). The box goes
 * back to 'open' and its packages lose both verified flags so the worker
 * re-scans them before re-closing (closeShippingBox re-checks auto-finish,
 * which is a no-op for the already-finished order).
 */
export async function reopenShippingBox(db: AppDb, input: { shippingBoxId: string; actorId: string }): Promise<void> {
  return db.transaction(async (tx) => {
    const box = await loadShippingBox(tx, input.shippingBoxId);
    await assertActor(tx, input.actorId);
    if (box.status !== "closed") throw new HTTPException(409, { message: "shipping_box_not_closed" });
    const task = await queryGet<{ status: string }>(
      tx,
      sql`SELECT status FROM verify_tasks WHERE picking_order_id = ${box.pickingOrderId}`
    );
    if (!task || task.status !== "pending") throw new HTTPException(409, { message: "verify_task_not_pending" });

    await queryRun(tx, sql`UPDATE shipping_boxes SET status = 'open', last_update_date = ${now()} WHERE id = ${box.id}`);
    await queryRun(
      tx,
      sql`UPDATE picking_packages SET verified = false, verify_verified = false, last_update_date = ${now()} WHERE shipping_box_id = ${box.id}`
    );
    await logTransition(tx, {
      entityType: "shipping_box",
      entityId: box.id,
      fromState: "closed",
      toState: "open",
      actorId: input.actorId,
      metadata: { reopen: true },
    });
  });
}

// ---------------------------------------------------------------------------
// Issue reporting (ported from pickingIssues.ts; per-order entries carry their
// own reason/qty/packSize/note/remark — no shared-remark hack).
// ---------------------------------------------------------------------------

export const PICKING_ISSUE_REASONS = ["insufficient_stock", "cannot_divide", "merge", "other"] as const;
export type PickingIssueReason = (typeof PICKING_ISSUE_REASONS)[number];

export interface PickingIssueEntry {
  pickingOrderId: string;
  reason: PickingIssueReason;
  qty?: number | null;
  packSize?: number | null;
  note?: string | null;
  remark?: string | null;
}

interface IssueOrderRow {
  id: string;
  orderNo: string;
  status: string;
  totalQty: number;
}

/** Report picking issues per order: sets the issue fields + 'issue' status and
 *  logs the transition. Unknown ids and non-pending/picking orders are skipped. */
export async function reportPickingOrderIssues(
  db: AppDb,
  input: { actorId: string; entries: PickingIssueEntry[] }
): Promise<{ reported: string[]; skipped: string[] }> {
  return db.transaction(async (tx) => {
    if (input.entries.length === 0) throw new HTTPException(400, { message: "no_orders_selected" });
    for (const e of input.entries) {
      if (!PICKING_ISSUE_REASONS.includes(e.reason)) {
        throw new HTTPException(400, { message: "unhandled_issue_reason" });
      }
      if (e.reason === "insufficient_stock" && (e.qty == null || !Number.isInteger(e.qty) || e.qty < 0)) {
        throw new HTTPException(400, { message: "actual_quantity_required" });
      }
      if (e.reason === "cannot_divide" && (e.packSize == null || !Number.isInteger(e.packSize) || e.packSize <= 0)) {
        throw new HTTPException(400, { message: "pack_size_required" });
      }
    }
    if (input.entries.some((e) => e.reason === "merge") && input.entries.length < 2) {
      throw new HTTPException(400, { message: "select_at_least_two_orders_to_merge" });
    }
    await assertActor(tx, input.actorId);

    // First entry per order wins; keep the caller's order.
    const byOrder = new Map<string, PickingIssueEntry>();
    for (const e of input.entries) {
      if (!byOrder.has(e.pickingOrderId)) byOrder.set(e.pickingOrderId, e);
    }
    const ids = [...byOrder.keys()];
    const rows = await queryAll<IssueOrderRow>(
      tx,
      sql`SELECT po.id, po.order_no AS "orderNo", po.status,
            (SELECT COALESCE(SUM(pi.qty)::int, 0) FROM picking_items pi WHERE pi.picking_order_id = po.id) AS "totalQty"
          FROM picking_orders po WHERE ${inArray(sql`po.id`, ids)}`
    );
    const found = new Map(rows.map((r) => [r.id, r]));
    const reportable: { entry: PickingIssueEntry; row: IssueOrderRow }[] = [];
    for (const id of ids) {
      const row = found.get(id);
      if (row && (row.status === "pending" || row.status === "picking")) {
        reportable.push({ entry: byOrder.get(id)!, row });
      }
    }
    if (reportable.length === 0) throw new HTTPException(400, { message: "no_reportable_orders_selected" });

    const reported: string[] = [];
    for (const { entry, row } of reportable) {
      if (entry.reason === "insufficient_stock" && entry.qty! >= row.totalQty) {
        throw new HTTPException(400, { message: "actual_qty_must_be_less_than_requested" });
      }
      const note = entry.note?.trim() || null;
      const remark = entry.remark?.trim() || null;
      const at = now();
      await queryRun(
        tx,
        sql`UPDATE picking_orders
            SET status = 'issue',
                issue_reason = ${entry.reason},
                issue_qty = ${entry.reason === "insufficient_stock" ? entry.qty! : null},
                issue_pack_size = ${entry.reason === "cannot_divide" ? entry.packSize! : null},
                issue_note = ${note},
                issue_remark = ${remark},
                issue_reported_at = ${at},
                issue_reported_by = ${input.actorId},
                last_update_date = ${at}
            WHERE id = ${row.id}`
      );
      await logTransition(tx, {
        entityType: "picking_order",
        entityId: row.id,
        fromState: row.status,
        toState: "issue",
        actorId: input.actorId,
        metadata: {
          reason: entry.reason,
          ...(entry.qty != null ? { qty: entry.qty } : {}),
          ...(entry.packSize != null ? { packSize: entry.packSize } : {}),
        },
      });
      await emitEvent(tx, {
        type: "picking_order.issue_reported",
        topics: ["/picking-orders"],
        data: { id: row.id, orderNo: row.orderNo, reason: entry.reason, actorId: input.actorId },
      });
      reported.push(row.id);
    }
    const reportedSet = new Set(reported);
    return { reported, skipped: ids.filter((id) => !reportedSet.has(id)) };
  });
}

/** Resolve an open picking issue (admin): back to 'pending' with the issue
 *  fields cleared, transition log + SSE event. The caller runs allocateAll
 *  after commit so the order takes part in allocation again. */
export async function resolvePickingOrderIssue(
  db: AppDb,
  input: { orderId: string; actorId: string; resolutionNote?: string | null }
): Promise<{ id: string; orderNo: string; status: string }> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string; orderNo: string; status: string; issueReason: string | null }>(
      tx,
      sql`SELECT id, order_no AS "orderNo", status, issue_reason AS "issueReason"
          FROM picking_orders WHERE id = ${input.orderId}`
    );
    if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });
    if (order.status !== "issue") throw new HTTPException(409, { message: "picking_order_no_open_issue" });
    await assertActor(tx, input.actorId);

    const resolutionNote = input.resolutionNote?.trim() || null;
    await queryRun(
      tx,
      sql`UPDATE picking_orders
          SET status = 'pending',
              issue_reason = NULL,
              issue_qty = NULL,
              issue_pack_size = NULL,
              issue_note = NULL,
              issue_remark = NULL,
              issue_reported_at = NULL,
              issue_reported_by = NULL,
              last_update_date = ${now()}
          WHERE id = ${order.id}`
    );
    await logTransition(tx, {
      entityType: "picking_order",
      entityId: order.id,
      fromState: "issue",
      toState: "pending",
      actorId: input.actorId,
      metadata: { reason: order.issueReason, resolutionNote },
    });
    await emitEvent(tx, {
      type: "picking_order.updated",
      topics: ["/picking-orders"],
      data: { id: order.id, orderNo: order.orderNo, actorId: input.actorId },
    });
    return { id: order.id, orderNo: order.orderNo, status: "pending" };
  });
}

// --- admin audit logs (2026-07-27 design) --------------------------------------

export interface TransactionLogRow {
  id: string;
  entityType: string;
  entityId: string;
  fromState: string | null;
  toState: string;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdDate: Date;
}

/** Audit trail for one picking order: order-level rows plus the rows logged
 *  against its items, packages, and shipping boxes, newest first. 404 when
 *  the order does not exist. */
export async function listPickingOrderLogs(db: AppDb, orderId: string): Promise<TransactionLogRow[]> {
  const order = await queryGet<{ id: string }>(db, sql`SELECT id FROM picking_orders WHERE id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });
  return queryAll<TransactionLogRow>(
    db,
    sql`SELECT tl.id, tl.entity_type AS "entityType", tl.entity_id AS "entityId",
               tl.from_state AS "fromState", tl.to_state AS "toState",
               tl.actor_id AS "actorId", u.display_name AS "actorName",
               tl.metadata, tl.created_date AS "createdDate"
        FROM transaction_logs tl
        LEFT JOIN users u ON u.id = tl.actor_id
        WHERE (tl.entity_type = 'picking_order' AND tl.entity_id = ${orderId})
           OR (tl.entity_type = 'picking_item' AND tl.entity_id IN (
                 SELECT id FROM picking_items WHERE picking_order_id = ${orderId}))
           OR (tl.entity_type = 'picking_package' AND tl.entity_id IN (
                 SELECT id FROM picking_packages WHERE picking_order_id = ${orderId}))
           OR (tl.entity_type = 'shipping_box' AND tl.entity_id IN (
                 SELECT id FROM shipping_boxes WHERE picking_order_id = ${orderId}))
        ORDER BY tl.created_date DESC, tl.id DESC`
  );
}
