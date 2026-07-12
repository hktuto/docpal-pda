import { createApiClient } from "../apiClient";
import type {
  WarehouseService,
  CreateWarehouseServiceOptions,
} from "../warehouse";
import type {
  ReceivingOrderSummary,
  ReceivingOrderStatus,
  ReceivingOrderDetail,
  ReceivingItemWithMismatch,
  ReceivingItemMismatch,
  MismatchReason,
  MismatchStatus,
  ReportMismatchInput,
  PickingByReceivingRow,
  DisplayPackage,
  DisplayBox,
  TransitionLog,
  PickingOrderSummary,
  PickingOrderStatus,
  PickingOrderDetail,
  PickingIssueReason,
  PickingItem,
  PickingAllocation,
  PickingPackage,
  ShippingBox,
  Part,
} from "../types";

type RawRow = Record<string, any>;

function toSummary(row: RawRow): ReceivingOrderSummary {
  return {
    id: String(row.id),
    refNo: String(row.ref_no),
    status: row.status as ReceivingOrderStatus,
    deliveryDate: row.delivery_date ? String(row.delivery_date) : null,
    supplierName: row.supplier_name ? String(row.supplier_name) : null,
    remainingItems: Number(row.remaining_items ?? 0),
    pendingPickingOrders: Number(row.pending_picking_orders ?? 0),
  };
}

function toMismatch(row: RawRow): ReceivingItemMismatch {
  return {
    id: String(row.id),
    receivingInvoiceItemId: String(row.receiving_invoice_item_id),
    reason: row.kind as MismatchReason,
    mismatchQty: row.mismatch_qty ?? null,
    wrongPartNo: row.wrong_part_no ?? null,
    note: row.note ?? null,
    status: row.status as MismatchStatus,
    effectiveReceivedQty: Number(row.effective_received_qty ?? 0),
    previousReceivedQty: Number(row.previous_received_qty ?? 0),
    reportedBy: row.reported_by ?? null,
    reportedAt: new Date(row.created_at),
    confirmedBy: row.confirmed_by ?? null,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
    cancelledBy: row.cancelled_by ?? null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at) : null,
  };
}

// The API detail query does not return po_no/po_line on items nor
// internal_code/default_coo on parts; they default to null.
function toDetailItem(row: RawRow): ReceivingItemWithMismatch {
  return {
    id: String(row.id),
    receivingInvoiceId: String(row.receiving_invoice_id),
    partId: String(row.part_id),
    poNo: row.po_no ?? null,
    poLine: row.po_line ?? null,
    qty: Number(row.qty),
    receivedQty: Number(row.received_qty ?? 0),
    pickedQty: Number(row.picked_qty ?? 0),
    putAwayQty: Number(row.put_away_qty ?? 0),
    boxId: row.box_id ?? null,
    dateCode: row.date_code ?? null,
    lotCode: row.lot_code ?? null,
    coo: row.coo ?? null,
    cow: row.cow ?? null,
    part: row.part
      ? {
          id: String(row.part.id),
          partNo: String(row.part.part_no),
          internalCode: row.part.internal_code ?? null,
          description: row.part.description ?? null,
          defaultCoo: row.part.default_coo ?? null,
        }
      : null,
    mismatch: row.mismatch ? toMismatch(row.mismatch) : null,
  };
}

// PickingByReceivingRow is intentionally snake_case (types.ts); the API rows
// match it column for column.
function toPickingByReceivingRow(row: RawRow): PickingByReceivingRow {
  return {
    picking_order_id: String(row.picking_order_id),
    picking_order_ref: String(row.picking_order_ref),
    picking_order_status: String(row.picking_order_status),
    picking_order_ship_to: row.picking_order_ship_to ?? null,
    picking_item_id: String(row.picking_item_id),
    required_qty: Number(row.required_qty ?? 0),
    picked_qty: Number(row.picked_qty ?? 0),
    scanned_qty: Number(row.scanned_qty ?? 0),
    boxed_qty: Number(row.boxed_qty ?? 0),
    part_id: String(row.part_id),
    part_no: String(row.part_no),
    shelf_code: row.shelf_code ?? null,
    box_id: row.box_id ?? null,
    date_code: row.date_code ?? null,
    lot_code: row.lot_code ?? null,
    coo: row.coo ?? null,
    cow: row.cow ?? null,
    allocated_qty: Number(row.allocated_qty ?? 0),
    allocation_id: String(row.allocation_id),
  };
}

// API package rows lack picking_order_id; a picking item belongs to exactly
// one picking order, so it is derived from the picking rows.
function toDisplayPackage(row: RawRow, orderByItem: Map<string, string>): DisplayPackage {
  const pickingItemId = String(row.picking_item_id);
  return {
    id: String(row.id),
    pickingItemId,
    pickingOrderId: orderByItem.get(pickingItemId) ?? "",
    qty: Number(row.qty),
    shippingBoxId: row.shipping_box_id ?? null,
    dateCode: row.date_code ?? null,
    lotCode: row.lot_code ?? null,
    coo: row.coo ?? null,
    cow: row.cow ?? null,
    createdAt: row.created_at,
  };
}

function toTransitionLog(row: RawRow): TransitionLog {
  return {
    id: String(row.id),
    entityId: String(row.entity_id),
    fromState: row.from_status ?? null,
    toState: String(row.to_status),
    metadata: row.note ?? null,
    createdAt: new Date(row.created_at),
    actorName: row.actor_name ?? null,
  };
}

function mismatchBody(input: ReportMismatchInput, actorId: string | undefined) {
  return {
    reason: input.reason,
    mismatch_qty: input.mismatchQty ?? null,
    wrong_part_no: input.wrongPartNo ?? null,
    note: input.note ?? null,
    actor_id: actorId,
  };
}

// ------------------------------------------------------------------
// Picking
// ------------------------------------------------------------------

/** Routes that take actor_id in the query string (client.post has no params). */
function withActorQuery(path: string, actorId: string | undefined): string {
  return actorId ? `${path}?actor_id=${encodeURIComponent(actorId)}` : path;
}

function toPickingOrderSummary(row: RawRow): PickingOrderSummary {
  return {
    id: String(row.id),
    refNo: String(row.ref_no),
    status: row.status as PickingOrderStatus,
    // API list rows carry neither delivery_date nor supplier_name (API gaps).
    deliveryDate: row.delivery_date ? String(row.delivery_date) : null,
    supplierName: row.supplier_name ? String(row.supplier_name) : null,
    shipTo: row.ship_to ? String(row.ship_to) : null,
    totalQty: Number(row.total_qty ?? 0),
  };
}

// API item rows only carry part_id/part_no; the remaining Part columns are
// not served by the picking bundle and default to null.
function toBundlePart(row: RawRow): Part {
  return {
    id: String(row.part_id),
    partNo: String(row.part_no),
    internalCode: row.internal_code ?? null,
    description: row.description ?? null,
    defaultCoo: row.default_coo ?? null,
  };
}

// API package rows lack picking_order_id; every package in the bundle belongs
// to the fetched order, so it is derived from the order id.
function toBundlePackage(row: RawRow, orderId: string): PickingPackage {
  return {
    id: String(row.id),
    pickingItemId: String(row.picking_item_id),
    pickingOrderId: orderId,
    qty: Number(row.qty),
    shippingBoxId: row.shipping_box_id ?? null,
    dateCode: row.date_code ?? null,
    lotCode: row.lot_code ?? null,
    coo: row.coo ?? null,
    cow: row.cow ?? null,
    createdAt: new Date(row.created_at),
  };
}

// The API bundle does not nest pickingItem under allocations (pglite does);
// it is synthesized from the bundle's item rows so scan targets still resolve.
function toBundleAllocation(
  row: RawRow,
  itemById: Map<string, RawRow>
): PickingAllocation {
  const lot = row.lot as RawRow | null;
  const item = itemById.get(String(row.picking_item_id));
  return {
    id: String(row.id),
    pickingItemId: String(row.picking_item_id),
    qty: Number(row.qty),
    remark: row.remark ?? null,
    inventoryLot: lot
      ? {
          id: String(lot.id),
          partId: String(lot.part_id),
          dateCode: lot.date_code ?? null,
          lotCode: lot.lot_code ?? null,
          coo: lot.coo ?? null,
          cow: lot.cow ?? null,
          shelfCode: lot.shelf_code ?? null,
          boxId: lot.box_id ?? null,
        }
      : null,
    receivingOrder: row.receiving_order_id
      ? {
          id: String(row.receiving_order_id),
          refNo: String(row.receiving_order_ref_no),
        }
      : null,
    pickingItem: item
      ? { id: String(item.id), part: toBundlePart(item) }
      : null,
  };
}

function toBundleItem(
  row: RawRow,
  orderId: string,
  allocations: PickingAllocation[],
  packages: PickingPackage[]
): PickingItem {
  const itemId = String(row.id);
  return {
    id: itemId,
    pickingOrderId: orderId,
    partId: String(row.part_id),
    qty: Number(row.qty),
    pickedQty: Number(row.picked_qty ?? 0),
    allocatedQty: Number(row.allocated_qty ?? 0),
    requiredDateCode: row.required_date_code ?? null,
    sourceShelfCode: row.source_shelf_code ?? null,
    part: toBundlePart(row),
    allocations: allocations.filter((a) => a.pickingItemId === itemId),
    packages: packages.filter((p) => p.pickingItemId === itemId),
  };
}

function toPickingOrderDetailBundle(bundle: RawRow): PickingOrderDetail {
  const order = (bundle.order ?? {}) as RawRow;
  const orderId = String(order.id);
  const itemRows = (bundle.items ?? []) as RawRow[];
  const itemById = new Map(itemRows.map((it) => [String(it.id), it]));
  const allocations = ((bundle.allocations ?? []) as RawRow[]).map((a) =>
    toBundleAllocation(a, itemById)
  );
  const packages = ((bundle.packages ?? []) as RawRow[]).map((p) =>
    toBundlePackage(p, orderId)
  );
  const measuringTask = bundle.measuring_task as RawRow | null;

  const shippingBoxes: ShippingBox[] = ((bundle.boxes ?? []) as RawRow[]).map(
    (b) => ({
      id: String(b.id),
      pickingOrderId: orderId,
      status: String(b.status),
      packages: packages.filter((p) => p.shippingBoxId === String(b.id)),
    })
  );

  return {
    id: orderId,
    refNo: String(order.ref_no),
    status: order.status as PickingOrderStatus,
    // The bundle's order select has no delivery_date/supplier/po_no/
    // required_date_code_notice columns (API gaps); they default to null.
    deliveryDate: order.delivery_date ? new Date(order.delivery_date) : null,
    supplier: null,
    poNo: order.po_no ?? null,
    shipTo: order.ship_to ?? null,
    destinationCountry: order.destination_country ?? null,
    requiredDateCodeNotice: order.required_date_code_notice ?? null,
    items: itemRows.map((it) =>
      toBundleItem(it, orderId, allocations, packages)
    ),
    shippingBoxes,
    measuringTask: measuringTask
      ? { id: String(measuringTask.id), status: String(measuringTask.status) }
      : null,
    issueReason: (order.issue_reason as PickingIssueReason) ?? null,
    issueQty: order.issue_qty ?? null,
    issuePackSize: order.issue_pack_size ?? null,
    issueNote: order.issue_note ?? null,
    issueRemark: order.issue_remark ?? null,
    issueReportedAt: order.issue_reported_at
      ? new Date(order.issue_reported_at)
      : null,
    issueReportedBy: order.issue_reported_by ?? null,
    issueReportedByUser: order.issue_reported_by_name
      ? { displayName: String(order.issue_reported_by_name) }
      : null,
  };
}

export function createApiWarehouseService(
  options: CreateWarehouseServiceOptions
): WarehouseService {
  const client = createApiClient({
    baseUrl: options.apiBaseUrl ?? "",
    getActorId: options.getActorId,
  });

  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented");
  };

  return {
    async getReceivingOrders(filter) {
      const rows = await client.get<RawRow[]>("/receiving-orders", {
        status: filter === "all" ? undefined : filter,
      });
      return rows.map(toSummary);
    },

    async getReceivingOrder(id) {
      const [order, picking] = await Promise.all([
        client.get<RawRow>(`/receiving-orders/${id}`),
        client.get<RawRow>(`/receiving-orders/${id}/picking`),
      ]);

      const pickingRows = ((picking.rows ?? []) as RawRow[]).map(
        toPickingByReceivingRow
      );
      const itemIds = Array.from(
        new Set(pickingRows.map((r) => r.picking_item_id))
      );

      // The picking bundle's transition_logs are keyed by picking ORDER id,
      // but the web indexes logs by picking ITEM id — fetch those explicitly.
      const rawLogs = itemIds.length
        ? (
            await client.post<{ logs: RawRow[] }>(
              "/picking-items/transition-logs",
              { ids: itemIds }
            )
          ).logs
        : [];

      const orderByItem = new Map(
        pickingRows.map((r) => [r.picking_item_id, r.picking_order_id])
      );

      const packagesByItem: Record<string, DisplayPackage[]> = {};
      for (const [itemId, pkgs] of Object.entries(
        (picking.packages_by_item ?? {}) as Record<string, RawRow[]>
      )) {
        packagesByItem[itemId] = pkgs.map((p) =>
          toDisplayPackage(p, orderByItem)
        );
      }

      const boxesByOrder: Record<string, DisplayBox[]> = {};
      for (const [orderId, boxes] of Object.entries(
        (picking.boxes_by_order ?? {}) as Record<string, RawRow[]>
      )) {
        boxesByOrder[orderId] = boxes.map((b) => ({
          id: String(b.id),
          pickingOrderId: String(b.picking_order_id),
          status: String(b.status),
        }));
      }

      const transitionLogs: Record<string, TransitionLog[]> = {};
      for (const raw of rawLogs ?? []) {
        const log = toTransitionLog(raw);
        (transitionLogs[log.entityId] ??= []).push(log);
      }

      const supplier = order.supplier as RawRow | null;

      const detail: ReceivingOrderDetail = {
        id: String(order.id),
        refNo: String(order.ref_no),
        status: order.status as ReceivingOrderStatus,
        deliveryDate: order.delivery_date
          ? new Date(order.delivery_date)
          : null,
        supplier: supplier
          ? {
              id: String(supplier.id),
              code: String(supplier.code),
              name: String(supplier.name),
              qrcodeTemplate: supplier.qr_template ?? null,
              qrcodeQtyEncoding: supplier.qrcode_qty_encoding ?? null,
            }
          : null,
        invoices: ((order.invoices ?? []) as RawRow[]).map((inv) => ({
          id: String(inv.id),
          receivingOrderId: String(inv.receiving_order_id),
          invoiceNo: String(inv.invoice_no),
          supplierId: inv.supplier_id ?? null,
          items: ((inv.items ?? []) as RawRow[]).map(toDetailItem),
        })),
        remainingItems: Number(order.remaining_items ?? 0),
        allocatedByItem: (order.allocated_by_item ?? {}) as Record<
          string,
          number
        >,
        pickingRows,
        packagesByItem,
        boxesByOrder,
        transitionLogs,
      };
      return detail;
    },

    async confirmReceivingOrderArrived(id) {
      await client.post(`/receiving-orders/${id}/confirm-arrival`);
    },

    async getActiveMismatch(itemId) {
      const row = await client.get<RawRow | null>(
        `/receiving-invoice-items/${itemId}/mismatch`
      );
      return row ? toMismatch(row) : null;
    },

    async reportMismatch(itemId, input) {
      await client.post(
        `/receiving-invoice-items/${itemId}/mismatches`,
        mismatchBody(input, client.actorId())
      );
    },

    async editMismatch(mismatchId, input) {
      await client.patch(
        `/mismatches/${mismatchId}`,
        mismatchBody(input, client.actorId())
      );
    },

    async confirmMismatch(mismatchId) {
      await client.post(`/mismatches/${mismatchId}/confirm`, {
        actor_id: client.actorId(),
      });
    },

    async cancelMismatch(mismatchId) {
      await client.post(`/mismatches/${mismatchId}/cancel`, {
        actor_id: client.actorId(),
      });
    },

    async getPickingOrdersByReceivingOrder(id) {
      const picking = await client.get<RawRow>(
        `/receiving-orders/${id}/picking`
      );
      return ((picking.rows ?? []) as RawRow[]).map(toPickingByReceivingRow);
    },

    async getPickingItemTransitionLogs(ids) {
      if (ids.length === 0) return [];
      const res = await client.post<{ logs: RawRow[] }>(
        "/picking-items/transition-logs",
        { ids }
      );
      return (res.logs ?? []).map(toTransitionLog);
    },

    async createShippingBoxForPickingOrder(pickingOrderId) {
      await client.post(`/picking-orders/${pickingOrderId}/boxes`, {
        actor_id: client.actorId(),
      });
    },

    async addPackageToBox(packageId, boxId) {
      await client.post(`/packages/${packageId}/add-to-box`, {
        box_id: boxId,
        actor_id: client.actorId(),
      });
    },

    // The flat DELETE dispatches on shipping_box_id: boxed -> unbox,
    // unboxed -> delete the scanned package.
    async removePackageFromBox(packageId) {
      await client.del(`/packages/${packageId}`, {
        actor_id: client.actorId(),
      });
    },

    async removeScannedPackage(packageId) {
      await client.del(`/packages/${packageId}`, {
        actor_id: client.actorId(),
      });
    },

    async getPickingOrders() {
      const rows = await client.get<RawRow[]>("/picking-orders");
      return rows.map(toPickingOrderSummary);
    },

    async getPickingOrder(id) {
      const bundle = await client.get<RawRow>(`/picking-orders/${id}`);
      return toPickingOrderDetailBundle(bundle);
    },

    async finishPickingOrder(id) {
      await client.post(
        withActorQuery(`/picking-orders/${id}/finish`, client.actorId())
      );
    },

    async reportPickingOrderIssues(entries, input) {
      // The API takes a single remark applied to every reported order and
      // has no counterpart for the web's shared `note` (issue_note stays
      // NULL); distinct per-entry remarks are joined to preserve them.
      const remarks = Array.from(
        new Set(
          entries
            .map((e) => e.remark?.trim())
            .filter((r): r is string => !!r)
        )
      );
      const res = await client.post<{
        reported: string[];
        skipped: string[];
      }>("/picking-orders/report-issues", {
        picking_order_ids: entries.map((e) => e.orderId),
        reason: input.reason,
        qty: input.qty ?? null,
        pack_size: input.packSize ?? null,
        remark: remarks.length ? remarks.join("; ") : null,
        actor_id: client.actorId(),
      });
      return {
        reported: (res.reported ?? []).length,
        skipped: (res.skipped ?? []).length,
      };
    },

    async scanAllocation(id, qty) {
      const res = await client.post<{ package_ids: string[] }>(
        `/allocations/${id}/scan`,
        { qty, actor_id: client.actorId() }
      );
      return res.package_ids[0] ?? "";
    },

    async applyOcrPick(input) {
      // The route lives under /picking-orders even though :id is the
      // RECEIVING order id (see apps/api/src/routes/picking.ts).
      await client.post(`/picking-orders/${input.receivingOrderId}/ocr-pick`, {
        picking_item_id: input.pickingItemId,
        qty: input.qty,
        date_code: input.dateCode ?? null,
        lot_code: input.lotCode ?? null,
        coo: input.coo ?? null,
        cow: input.cow ?? null,
        actor_id: client.actorId(),
      });
    },

    async addAllUnboxedPackagesToBox(boxId) {
      // The only API route for this is nested under the picking order, but
      // the interface supplies just the box id — resolve the order through
      // the box lookup first.
      const lookup = await client.get<RawRow>(
        `/shipping-boxes/${boxId}/for-measuring`
      );
      const orderId = String((lookup.box as RawRow).picking_order_id);
      const res = await client.post<{ packed: number }>(
        withActorQuery(
          `/picking-orders/${orderId}/boxes/${boxId}/add-all-unboxed`,
          client.actorId()
        )
      );
      return Number(res.packed ?? 0);
    },

    async cancelShippingBox(id) {
      await client.post(
        withActorQuery(`/shipping-boxes/${id}/cancel`, client.actorId())
      );
    },
    getPutAwayCandidates: notImplemented,
    getPutAwayLots: notImplemented,
    getPutAwayScans: notImplemented,
    getShelfBoxesForReceivingOrder: notImplemented,
    getShelves: notImplemented,
    recordPutAwayScan: notImplemented,
    assignPutAwayScanToBox: notImplemented,
    addAllUnboxedScansToBox: notImplemented,
    removePutAwayScanFromBox: notImplemented,
    removePutAwayScannedPiece: notImplemented,
    createShelfBox: notImplemented,
    closeShelfBox: notImplemented,
    cancelShelfBox: notImplemented,
    getMeasuringTasks: notImplemented,
    getMeasuringTask: notImplemented,
    getShippingBoxForMeasuring: notImplemented,
    findMatchingUnverifiedPackage: notImplemented,
    verifyPickingPackage: notImplemented,
    updateShippingBox: notImplemented,
    closeShippingBox: notImplemented,
    completeMeasuringTask: notImplemented,
    getShelvesWithBoxes: notImplemented,
    getShelfBoxes: notImplemented,
    getShelfBox: notImplemented,
    verifyShelfBoxItem: notImplemented,
    markShelfBoxVerified: notImplemented,
    getSuppliersWithInventoryStats: notImplemented,
    getPartsBySupplier: notImplemented,
    getInventoryLotsForParts: notImplemented,
  };
}
