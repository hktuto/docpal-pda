import { createApiClient } from "../apiClient";
import { I18nError } from "~/composables/i18nError";
import { normalizeString } from "~/utils/text";
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
  PutAwayCandidate,
  PutAwayLot,
  PutAwayScan,
  ShelfBox,
  Shelf,
  MeasuringTaskStatus,
  MeasuringPickingOrder,
  MeasuringShippingBox,
  MeasuringPackage,
  BoxStatus,
  ShelfWithBoxCount,
  GoodsVerifyShelfBoxSummary,
  GoodsVerifyShelfBoxDetail,
  StockSearchSupplierWithStats,
  StockSearchPart,
  StockSearchInventoryLot,
  ScanCandidates,
  ReceivingCandidate,
  PickingCandidate,
  SupplierQrcodeTemplate,
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

// ------------------------------------------------------------------
// Put-away + shelves
// ------------------------------------------------------------------

// The candidates route also returns unboxed_qty, which the summary type has
// no field for; it is intentionally dropped.
function toPutAwayCandidate(row: RawRow): PutAwayCandidate {
  return {
    id: String(row.id),
    refNo: String(row.ref_no),
    status: String(row.status),
    supplierName: row.supplier_name ? String(row.supplier_name) : null,
    availableQty: Number(row.available_qty ?? 0),
  };
}

function toPutAwayLot(row: RawRow): PutAwayLot {
  return {
    receivingInvoiceItemId: String(row.receiving_invoice_item_id),
    partId: String(row.part_id),
    partNo: row.part_no ? String(row.part_no) : null,
    dateCode: row.date_code ? String(row.date_code) : null,
    lotCode: row.lot_code ? String(row.lot_code) : null,
    coo: row.coo ? String(row.coo) : null,
    cow: row.cow ? String(row.cow) : null,
    totalQty: Number(row.total_qty ?? 0),
    availableQty: Number(row.available_qty ?? 0),
    scannedQty: Number(row.scanned_qty ?? 0),
    boxedQty: Number(row.boxed_qty ?? 0),
  };
}

// API scan rows carry SQLite 0/1 verified flags and ISO date strings. The
// put_away_scans table has no part_id column; only the list route joins it
// in, so the full row from POST /put-away/scans maps partId to "" (API gap).
function toPutAwayScan(row: RawRow): PutAwayScan {
  return {
    id: String(row.id),
    receivingInvoiceItemId: String(row.receiving_invoice_item_id),
    partId: row.part_id ? String(row.part_id) : "",
    qty: Number(row.qty ?? 0),
    dateCode: row.date_code ?? null,
    lotCode: row.lot_code ?? null,
    coo: row.coo ?? null,
    cow: row.cow ?? null,
    shelfBoxId: row.shelf_box_id ?? null,
    verified: Boolean(row.verified),
    verifiedAt: row.verified_at ? new Date(row.verified_at) : null,
    createdAt: new Date(row.created_at),
  };
}

// API box items are grouped per (box, part) and carry no id column; part_id
// is unique within a box, so it doubles as the item id (used as a list key).
function toShelfBox(row: RawRow): ShelfBox {
  return {
    id: String(row.id),
    receivingOrderId: row.receiving_order_id
      ? String(row.receiving_order_id)
      : "",
    shelfCode: row.shelf_code ?? null,
    status: String(row.status),
    createdAt: new Date(row.created_at),
    items: ((row.items ?? []) as RawRow[]).map((it) => ({
      id: String(it.part_id),
      partId: String(it.part_id),
      part: { partNo: it.part_no ? String(it.part_no) : null },
      qty: Number(it.qty ?? 0),
      verified: Boolean(it.verified),
    })),
  };
}

// The API shelves table has no zone column (unlike the web schema), so shelf
// responses expose code only and zone stays null (documented API gap).
function toShelf(row: RawRow): Shelf {
  return {
    code: String(row.code),
    zone: row.zone ?? null,
  };
}

// ------------------------------------------------------------------
// Measuring
// ------------------------------------------------------------------

/** The API stores box weights as integer grams; web DTOs use kg. */
function gramsToKg(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value) / 1000;
}

// Ported from db/measuring.ts normalizeWeight: undefined leaves the column
// untouched, null/"" clears it, non-finite input is rejected.
function normalizeWeightKg(
  value: number | string | null | undefined
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const num = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(num)) throw new I18nError("weight_must_be_number");
  return num;
}

function kgToGrams(
  value: number | string | null | undefined
): number | null | undefined {
  const kg = normalizeWeightKg(value);
  return kg === undefined || kg === null ? kg : Math.round(kg * 1000);
}

type MeasuringPartInfo = { partId: string; partNo: string | null };

function measuringPartByItem(items: RawRow[]): Map<string, MeasuringPartInfo> {
  return new Map(
    items.map((it) => [
      String(it.id),
      {
        partId: String(it.part_id),
        partNo: it.part_no ? String(it.part_no) : null,
      },
    ])
  );
}

// API package rows join part_no but not part_id; partId is resolved through
// the task's item rows when available, otherwise left empty (API gap).
function toApiMeasuringPackage(
  row: RawRow,
  partByItem: Map<string, MeasuringPartInfo>
): MeasuringPackage {
  const pickingItemId = String(row.picking_item_id);
  const info = partByItem.get(pickingItemId);
  return {
    id: String(row.id),
    pickingItemId,
    qty: Number(row.qty),
    dateCode: row.date_code ?? null,
    lotCode: row.lot_code ?? null,
    coo: row.coo ?? null,
    cow: row.cow ?? null,
    verified: Boolean(row.verified),
    pickingItem: {
      id: pickingItemId,
      partId: info?.partId ?? "",
      part: {
        id: info?.partId ?? "",
        partNo: row.part_no
          ? String(row.part_no)
          : info?.partNo ?? "",
        internalCode: null,
        description: null,
        defaultCoo: null,
      },
    },
  };
}

// The measuring detail query selects no supplier/delivery/po columns on the
// order and no allocations at all; those stay null/empty (API gaps).
function toApiMeasuringPickingOrder(
  order: RawRow,
  items: RawRow[]
): MeasuringPickingOrder {
  const orderId = String(order.id);
  return {
    id: orderId,
    refNo: order.ref_no ? String(order.ref_no) : null,
    supplierId: null,
    deliveryDate: null,
    poNo: null,
    requiredDateCodeNotice: null,
    shipTo: order.ship_to ? String(order.ship_to) : null,
    destinationCountry: order.destination_country
      ? String(order.destination_country)
      : null,
    status: order.status as PickingOrderStatus,
    createdAt: new Date(order.created_at),
    updatedAt: new Date(order.updated_at),
    supplier: null,
    items: items.map((it) => ({
      id: String(it.id),
      pickingOrderId: orderId,
      partId: String(it.part_id),
      qty: Number(it.qty),
      pickedQty: Number(it.picked_qty ?? 0),
      requiredDateCode: null,
      sourceShelfCode: null,
      part: {
        id: String(it.part_id),
        partNo: String(it.part_no),
        internalCode: null,
        description: null,
        defaultCoo: null,
      },
      allocations: [],
    })),
  };
}

// The API box row carries no picking_order_id/measuring_task_id; both are
// derived from the owning task.
function toApiMeasuringShippingBox(
  row: RawRow,
  orderId: string,
  taskId: string,
  partByItem: Map<string, MeasuringPartInfo>
): MeasuringShippingBox {
  return {
    id: String(row.id),
    pickingOrderId: orderId,
    measuringTaskId: taskId,
    status: row.status as BoxStatus,
    grossWeight: gramsToKg(row.gross_weight_g),
    netWeight: gramsToKg(row.net_weight_g),
    destinationCountry: row.destination_country ?? null,
    boxSize: row.box_size ?? null,
    createdAt: new Date(row.created_at),
    packages: ((row.packages ?? []) as RawRow[]).map((p) =>
      toApiMeasuringPackage(p, partByItem)
    ),
  };
}

// Scan matching semantics ported from db/measuring.ts: empty values on either
// side act as wildcards; codes fold common OCR confusables.
const normalizeScanValue = (value: string | null | undefined) =>
  (value ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ");

const normalizeScanCode = (value: string | null | undefined) =>
  normalizeScanValue(value)
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/Z/g, "2")
    .replace(/S/g, "5");

// ------------------------------------------------------------------
// Goods verify + stock search
// ------------------------------------------------------------------

// The API shelves table has no zone column (same gap as toShelf).
function toShelfWithBoxCount(row: RawRow): ShelfWithBoxCount {
  return {
    code: String(row.code),
    zone: row.zone ?? null,
    boxCount: Number(row.box_count ?? 0),
  };
}

function toGoodsVerifySummary(row: RawRow): GoodsVerifyShelfBoxSummary {
  return {
    id: String(row.id),
    shelfCode: row.shelf_code ?? null,
    status: row.status as BoxStatus,
    itemCount: Number(row.item_count ?? 0),
    verifiedCount: Number(row.verified_count ?? 0),
    lastCheckAt: row.last_check_at ? new Date(row.last_check_at) : null,
    checkedToday: Boolean(row.checked_today),
  };
}

function toStockSupplierStats(row: RawRow): StockSearchSupplierWithStats {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    totalParts: Number(row.total_parts ?? 0),
    partsWithInventory: Number(row.parts_with_inventory ?? 0),
  };
}

// The API parts table lacks internal_code/default_coo (API gap), so they
// default to null unless a row happens to carry them.
function toStockPart(row: RawRow): StockSearchPart {
  return {
    id: String(row.id),
    partNo: String(row.part_no),
    internalCode: row.internal_code ?? null,
    description: row.description ?? null,
    defaultCoo: row.default_coo ?? null,
  };
}

function toStockLot(row: RawRow): StockSearchInventoryLot {
  return {
    partId: String(row.part_id),
    dateCode: row.date_code ?? null,
    lotCode: row.lot_code ?? null,
    coo: row.coo ?? null,
    cow: row.cow ?? null,
    shelfCode: row.shelf_code ?? null,
    boxId: row.box_id ?? null,
    totalQty: Number(row.total_qty ?? 0),
    allocatedQty: Number(row.allocated_qty ?? 0),
    availableQty: Number(row.available_qty ?? 0),
    locationLabel: String(row.location_label),
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
    // The bundle's order select has no po_no/required_date_code_notice
    // columns (API gaps); they default to null.
    deliveryDate: order.delivery_date ? new Date(order.delivery_date) : null,
    supplier: order.supplier_id
      ? {
          id: String(order.supplier_id),
          code: String(order.supplier_code),
          name: String(order.supplier_name),
          qrcodeTemplate: order.supplier_qr_template ?? null,
          qrcodeQtyEncoding: order.supplier_qrcode_qty_encoding ?? null,
        }
      : null,
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
    async getPutAwayCandidates() {
      const rows = await client.get<RawRow[]>("/put-away/candidates");
      return rows.map(toPutAwayCandidate);
    },

    async getPutAwayLots(receivingOrderId) {
      const rows = await client.get<RawRow[]>(
        `/receiving-orders/${receivingOrderId}/put-away-lots`
      );
      return rows.map(toPutAwayLot);
    },

    async getPutAwayScans(receivingOrderId) {
      const rows = await client.get<RawRow[]>(
        `/receiving-orders/${receivingOrderId}/put-away-scans`
      );
      return rows.map(toPutAwayScan);
    },

    async getShelfBoxesForReceivingOrder(receivingOrderId) {
      const rows = await client.get<RawRow[]>(
        `/receiving-orders/${receivingOrderId}/shelf-boxes`
      );
      return rows.map(toShelfBox);
    },

    async getShelves() {
      const rows = await client.get<RawRow[]>("/shelves");
      return rows.map(toShelf);
    },

    async recordPutAwayScan(
      receivingInvoiceItemId,
      qty,
      dateCode,
      lotCode,
      coo,
      cow
    ) {
      // The route takes no actor_id (see RecordPutAwayScanRequest) and
      // returns the full created scan row.
      const row = await client.post<RawRow>("/put-away/scans", {
        receiving_invoice_item_id: receivingInvoiceItemId,
        qty,
        date_code: dateCode,
        lot_code: lotCode,
        coo,
        cow,
      });
      return toPutAwayScan(row);
    },

    async assignPutAwayScanToBox(scanId, boxId) {
      await client.post(`/put-away/scans/${scanId}/assign-to-box`, {
        shelf_box_id: boxId,
        actor_id: client.actorId(),
      });
    },

    async addAllUnboxedScansToBox(boxId) {
      const res = await client.post<{ count: number }>(
        withActorQuery(
          `/shelf-boxes/${boxId}/add-all-unboxed`,
          client.actorId()
        )
      );
      return Number(res.count ?? 0);
    },

    async removePutAwayScanFromBox(scanId) {
      await client.post(
        withActorQuery(
          `/put-away/scans/${scanId}/remove-from-box`,
          client.actorId()
        )
      );
    },

    async removePutAwayScannedPiece(scanId) {
      await client.post(`/put-away/scans/${scanId}/remove-piece`);
    },

    async createShelfBox(receivingOrderId, shelfCode) {
      // Returns the full created box row (no items on a fresh box).
      const row = await client.post<RawRow>(
        `/receiving-orders/${receivingOrderId}/shelf-boxes`,
        { shelf_code: shelfCode, actor_id: client.actorId() }
      );
      return toShelfBox(row);
    },

    async closeShelfBox(id) {
      await client.post(
        withActorQuery(`/shelf-boxes/${id}/close`, client.actorId())
      );
    },

    async cancelShelfBox(id) {
      await client.del(`/shelf-boxes/${id}`, { actor_id: client.actorId() });
    },
    async getMeasuringTasks() {
      // Mirrors pglite, which only lists pending tasks.
      const rows = await client.get<RawRow[]>("/measuring-tasks", {
        status: "pending",
      });
      return rows.map((row) => ({
        id: String(row.id),
        status: row.status as MeasuringTaskStatus,
        pickingOrderId: String(row.picking_order_id),
        pickingOrderRef: row.ref_no ? String(row.ref_no) : null,
        // The list query has no supplier join (API gap).
        supplierName: row.supplier_name ? String(row.supplier_name) : null,
        totalItems: Number(row.total_items ?? 0),
        packedItems: Number(row.packed_items ?? 0),
      }));
    },

    async getMeasuringTask(id) {
      const res = await client.get<RawRow>(`/measuring-tasks/${id}`);
      const task = (res.task ?? {}) as RawRow;
      const items = (res.items ?? []) as RawRow[];
      const partByItem = measuringPartByItem(items);
      const orderId = String(task.picking_order_id);
      return {
        id: String(task.id),
        status: task.status as MeasuringTaskStatus,
        pickingOrderId: orderId,
        createdAt: new Date(task.created_at),
        pickingOrder: res.order
          ? toApiMeasuringPickingOrder(res.order as RawRow, items)
          : null,
        shippingBoxes: ((res.boxes ?? []) as RawRow[]).map((b) =>
          toApiMeasuringShippingBox(b, orderId, String(task.id), partByItem)
        ),
      };
    },

    async getShippingBoxForMeasuring(id) {
      const res = await client.get<RawRow>(
        `/shipping-boxes/${id}/for-measuring`
      );
      const box = res.box as RawRow;
      const task = res.task as RawRow | null;
      // The for-measuring payload carries no part_id on packages; the
      // measuring task detail's item rows do, so fetch it when a task exists.
      const detail = task?.id
        ? await client.get<RawRow>(`/measuring-tasks/${task.id}`)
        : null;
      const items = (detail?.items ?? []) as RawRow[];
      const partByItem = measuringPartByItem(items);
      return {
        id: String(box.id),
        pickingOrderId: box.picking_order_id
          ? String(box.picking_order_id)
          : null,
        measuringTaskId: task ? String(task.id) : null,
        status: box.status as BoxStatus,
        grossWeight: gramsToKg(box.gross_weight_g),
        netWeight: gramsToKg(box.net_weight_g),
        destinationCountry: box.destination_country ?? null,
        boxSize: box.box_size ?? null,
        createdAt: new Date(box.created_at),
        measuringTask:
          task && detail
            ? {
                id: String(task.id),
                status: task.status as MeasuringTaskStatus,
                pickingOrder: detail.order
                  ? toApiMeasuringPickingOrder(detail.order as RawRow, items)
                  : null,
              }
            : null,
        packages: ((res.packages ?? []) as RawRow[]).map((p) =>
          toApiMeasuringPackage(p, partByItem)
        ),
      };
    },

    async findMatchingUnverifiedPackage(boxId, input, targetPackageId) {
      // No dedicated endpoint: reuse the for-measuring payload and run the
      // pglite match loop client-side (partId stays unresolved — API gap).
      const res = await client.get<RawRow>(
        `/shipping-boxes/${boxId}/for-measuring`
      );
      const rows = ((res.packages ?? []) as RawRow[]).filter(
        (p) => !p.verified
      );

      const partNo = normalizeScanValue(input.partNo);
      const dateCode = normalizeScanCode(input.dateCode);
      const lotCode = normalizeScanCode(input.lotCode);
      const coo = normalizeScanValue(input.coo);
      const cow = normalizeScanValue(input.cow);

      const matched =
        rows.find((pkg) => {
          if (targetPackageId && String(pkg.id) !== targetPackageId)
            return false;
          if (!pkg.part_no) return false;
          if (normalizeScanValue(String(pkg.part_no)) !== partNo) return false;
          const pkgDateCode = normalizeScanCode(pkg.date_code);
          if (dateCode && pkgDateCode && dateCode !== pkgDateCode) return false;
          const pkgLotCode = normalizeScanCode(pkg.lot_code);
          if (lotCode && pkgLotCode && lotCode !== pkgLotCode) return false;
          const pkgCoo = normalizeScanValue(pkg.coo);
          if (coo && pkgCoo && coo !== pkgCoo) return false;
          const pkgCow = normalizeScanValue(pkg.cow);
          if (cow && pkgCow && cow !== pkgCow) return false;
          return Number(pkg.qty) === input.qty;
        }) ?? null;

      return matched ? toApiMeasuringPackage(matched, new Map()) : null;
    },

    async verifyPickingPackage(packageId) {
      await client.post(`/packages/${packageId}/verify`, {
        actor_id: client.actorId(),
      });
    },

    async updateShippingBox(id, fields) {
      const body: Record<string, unknown> = {};
      if ("grossWeight" in fields)
        body.gross_weight_g = kgToGrams(fields.grossWeight);
      if ("netWeight" in fields)
        body.net_weight_g = kgToGrams(fields.netWeight);
      if ("destinationCountry" in fields)
        body.destination_country = normalizeString(fields.destinationCountry);
      if ("boxSize" in fields) body.box_size = normalizeString(fields.boxSize);
      // The route (PATCH /shipping-boxes/:id) takes no actor_id.
      await client.patch(`/shipping-boxes/${id}`, body);
    },

    async closeShippingBox(id) {
      await client.post(
        withActorQuery(`/shipping-boxes/${id}/close`, client.actorId())
      );
    },

    async completeMeasuringTask(id) {
      await client.post(
        withActorQuery(`/measuring-tasks/${id}/complete`, client.actorId())
      );
    },

    async getShelvesWithBoxes() {
      const rows = await client.get<RawRow[]>("/shelves/with-box-counts");
      return rows.map(toShelfWithBoxCount);
    },

    async getShelfBoxes(shelfCode) {
      const rows = await client.get<RawRow[]>(`/shelves/${shelfCode}/boxes`);
      return rows.map(toGoodsVerifySummary);
    },

    async getShelfBox(id) {
      const row = await client.get<RawRow>(`/shelf-boxes/${id}`);
      const boxId = String(row.id);
      const shelf = row.shelf as RawRow | null;
      const receivingOrder = row.receiving_order as RawRow | null;
      const detail: GoodsVerifyShelfBoxDetail = {
        id: boxId,
        receivingOrderId: row.receiving_order_id
          ? String(row.receiving_order_id)
          : null,
        shelfCode: row.shelf_code ?? null,
        status: row.status as BoxStatus,
        createdAt: new Date(row.created_at),
        shelf: shelf
          ? { code: String(shelf.code), zone: shelf.zone ?? null }
          : null,
        receivingOrder: receivingOrder
          ? {
              id: String(receivingOrder.id),
              refNo: String(receivingOrder.ref_no),
            }
          : null,
        // Item rows are grouped per (box, part) with no id column; the id is
        // synthesized exactly like db/goodsVerify.ts does.
        items: ((row.items ?? []) as RawRow[]).map((it) => {
          const partId = String(it.part_id);
          return {
            id: `${boxId}-${partId}`,
            shelfBoxId: boxId,
            partId,
            qty: Number(it.qty ?? 0),
            verified: Boolean(it.verified),
            verifiedAt: it.verified_at ? new Date(it.verified_at) : null,
            part: {
              partNo: it.part_no ? String(it.part_no) : null,
              description: it.description ? String(it.description) : null,
            },
          };
        }),
      };
      return detail;
    },

    async verifyShelfBoxItem(shelfBoxId, partId) {
      await client.post(`/shelf-boxes/${shelfBoxId}/verify-item`, {
        part_id: partId,
        actor_id: client.actorId(),
      });
    },

    async markShelfBoxVerified(id) {
      // The API has no direct box-verify route for shelf boxes; completing
      // the box's pending cycle_count verification task marks it verified.
      const tasks = await client.get<RawRow[]>("/verification-tasks", {
        kind: "cycle_count",
        status: "pending",
      });
      const task = tasks.find((t) => t.shelf_box_id === id);
      if (!task) throw new I18nError("shelf_box_not_found");
      await client.post(
        withActorQuery(
          `/verification-tasks/${task.id}/complete`,
          client.actorId()
        )
      );
    },

    async getSuppliersWithInventoryStats() {
      const rows = await client.get<RawRow[]>("/stock-search/suppliers");
      return rows.map(toStockSupplierStats);
    },

    async getPartsBySupplier(supplierId) {
      const rows = await client.get<RawRow[]>(
        `/stock-search/suppliers/${supplierId}/parts`
      );
      return rows.map(toStockPart);
    },

    async getInventoryLotsForParts(partIds) {
      // The route 400s on an empty part_ids param; pglite returns [].
      if (partIds.length === 0) return [];
      const rows = await client.get<RawRow[]>("/stock-search/parts/lots", {
        part_ids: partIds.join(","),
      });
      return rows.map(toStockLot);
    },

    async getScanCandidates(receivingOrderId): Promise<ScanCandidates> {
      // The API returns the same grouped maps the web builds from
      // findReceivingCandidatesForOrder / findPickingCandidatesForOrder:
      // receiving keyed by normalize()d part_no, picking keyed by part_id.
      // The keys pass through; only the row fields are camelCased.
      const res = await client.get<{
        receiving_by_part_no: Record<string, RawRow[]>;
        picking_by_part_id: Record<string, RawRow[]>;
      }>(`/receiving-orders/${receivingOrderId}/scan-candidates`);

      const receivingCandidatesByPartNo: Record<string, ReceivingCandidate[]> = {};
      for (const [key, rows] of Object.entries(res.receiving_by_part_no ?? {})) {
        receivingCandidatesByPartNo[key] = rows.map((row) => ({
          receivingInvoiceItemId: String(row.receiving_invoice_item_id),
          partId: String(row.part_id),
          partNo: String(row.part_no),
          dateCode: row.date_code != null ? String(row.date_code) : null,
          lotCode: row.lot_code != null ? String(row.lot_code) : null,
          coo: row.coo != null ? String(row.coo) : null,
          cow: row.cow != null ? String(row.cow) : null,
          availableQty: Number(row.available_qty),
        }));
      }

      const pickingCandidatesByPartId: Record<string, PickingCandidate[]> = {};
      for (const [key, rows] of Object.entries(res.picking_by_part_id ?? {})) {
        pickingCandidatesByPartId[key] = rows.map((row) => ({
          pickingOrderId: String(row.picking_order_id),
          pickingOrderRefNo: String(row.picking_order_ref_no),
          pickingItemId: String(row.picking_item_id),
          partId: String(row.part_id),
          shipTo: row.ship_to != null ? String(row.ship_to) : null,
          requiredQty: Number(row.required_qty),
          pickedQty: Number(row.picked_qty),
          remainingQty: Number(row.remaining_qty),
        }));
      }

      return { receivingCandidatesByPartNo, pickingCandidatesByPartId };
    },

    async getSupplierQrTemplates(): Promise<SupplierQrcodeTemplate[]> {
      const rows = await client.get<RawRow[]>("/suppliers/qr-templates");
      return rows.map((row) => ({
        code: String(row.code),
        qrcodeTemplate: String(row.qr_template),
        qrcodeQtyEncoding:
          row.qrcode_qty_encoding == null ? null : String(row.qrcode_qty_encoding),
      }));
    },

    async resetDemoData(): Promise<void> {
      await client.post("/dev/reset");
    },
  };
}
