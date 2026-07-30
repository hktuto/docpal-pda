/**
 * Typed wrappers over useApi for the backend's flow endpoints (non-`/admin`
 * reads the console needs: picking / receiving / shipping) plus the admin
 * flow-edit PATCHes. DTOs mirror the backend rows (camelCase JSON).
 */

// ---- picking ----

export interface PickingOrderRow {
  id: string;
  orderNo: string;
  status: string;
  poNo: string | null;
  shipTo: string | null;
  customerCode: string | null;
  deliveryDate: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  prioritySeq: number;
  workingBy: string | null;
  workingByName: string | null;
  itemCount: number;
  totalQty: number;
  pickedQty: number;
  allocationStatus: string;
  allocatedQty: number;
}

export interface PickingItemRow {
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
  allocations: {
    id: string;
    qty: number;
    boxId: string | null;
    receivingInvoiceItemId: string | null;
    receivingOrderId: string | null;
    lot: { id: string; shelfCode: string | null; boxId: string | null; dateCode: string | null; lotCode: string | null } | null;
  }[];
  packages: { id: string; qty: number; dateCode: string | null; lotCode: string | null; verified: boolean; verifyVerified: boolean; shippingBoxId: string | null }[];
}

export interface PickingOrderDetail extends Omit<PickingOrderRow, "itemCount" | "totalQty" | "pickedQty" | "prioritySeq" | "workingBy" | "workingByName"> {
  measuringTask: { id: string; status: string } | null;
  issueReason: string | null;
  issueQty: number | null;
  issuePackSize: number | null;
  issueNote: string | null;
  issueRemark: string | null;
  issueReportedAt: string | null;
  issueReportedBy: string | null;
  issueReportedByName: string | null;
  items: PickingItemRow[];
  boxes: { id: string; status: string; boxSize: string | null; grossWeight: number | null; netWeight: number | null; destinationCountry: string | null; packageCount: number }[];
}

// ---- receiving ----

export interface ReceivingOrderRow {
  id: string;
  batchNo: string;
  status: string;
  deliveryDate: string | null;
  dateCode: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  orgId: number;
  subInventoryCode: string;
  invoiceCount: number;
  itemCount: number;
  remainingItems: number;
  pendingPickingOrders: number;
}

export interface ReceivingItemRow {
  id: string;
  receivingInvoiceId: string;
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  lineQty: number;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  ctnNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  allocatedQty: number;
  mismatch: { reason: string | null; mismatchQty: number | null; wrongPartNo: string | null; note: string | null } | null;
}

export interface ReceivingOrderDetail {
  id: string;
  batchNo: string;
  status: string;
  deliveryDate: string | null;
  dateCode: string | null;
  orgId: number;
  subInventoryCode: string;
  supplier: { id: string; code: string; name: string; shortName: string | null } | null;
  invoices: {
    id: string;
    invoiceNo: string;
    totalQty: number | null;
    totalCtn: number | null;
    deliveryDate: string | null;
    orgId: number;
    subInventoryCode: string | null;
    items: ReceivingItemRow[];
  }[];
}

// ---- shipping (config-aware feed: verify / measuring / picking source) ----

export interface ShippingOrderRow {
  source: "verify" | "measuring" | "picking";
  taskId: string | null;
  pickingOrderId: string;
  orderNo: string;
  shipTo: string | null;
  boxCount: number;
  closedBoxCount: number;
  completedAt: string;
}

export interface ShippingOrderDetail {
  order: { id: string; orderNo: string; status: string; shipTo: string | null; customerCode: string | null; poNo: string | null };
  boxes: {
    id: string;
    status: string;
    boxSize: string | null;
    grossWeight: number | null;
    netWeight: number | null;
    destinationCountry: string | null;
    packages: { id: string; qty: number; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null; verified: boolean; verifyVerified: boolean; partNo: string; wclItemNo: string | null }[];
  }[];
}

// ---- stock search ----

export interface StockSearchPart {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  description: string | null;
  defaultCoo: string | null;
  onHandQty: number;
}

export interface StockSearchLot {
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

export interface StockSearchResult {
  parts: StockSearchPart[];
  lots: StockSearchLot[];
}

// ---- issues ----

export interface MismatchListRow {
  itemId: string;
  receivingOrderId: string;
  batchNo: string;
  invoiceId: string;
  invoiceNo: string;
  partNo: string;
  supplierCode: string | null;
  reason: string | null;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  note: string | null;
}

// ---- audit logs (transaction_logs rows for an order + its child entities) ----

export interface TransactionLogRow {
  id: string;
  entityType: string;
  entityId: string;
  fromState: string | null;
  toState: string;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdDate: string;
}

export function useFlowApi() {
  const api = useApi();
  return {
    // Picking
    listPickingOrders: (status?: string) =>
      api.get<PickingOrderRow[]>(`/picking-orders${status ? `?status=${status}` : ""}`),
    getPickingOrder: (id: string) => api.get<PickingOrderDetail>(`/picking-orders/${id}`),
    reorderPickingOrders: (orderIds: string[]) =>
      api.post<{ reordered: number }>(`/picking-orders/reorder`, { orderIds }),
    updatePickingDeliveryDate: (id: string, deliveryDate: string | null) =>
      api.patch(`/admin/picking-orders/${id}`, { deliveryDate }),

    // Receiving
    listReceivingOrders: (status?: string) =>
      api.get<ReceivingOrderRow[]>(`/receiving-orders${status ? `?status=${status}` : ""}`),
    getReceivingOrder: (id: string) => api.get<ReceivingOrderDetail>(`/receiving-orders/${id}`),
    updateReceivingDeliveryDate: (id: string, deliveryDate: string | null) =>
      api.patch(`/admin/receiving-orders/${id}`, { deliveryDate }),
    updateReceivingItemDateCode: (id: string, dateCode: string | null) =>
      api.patch(`/admin/receiving-invoice-items/${id}`, { dateCode }),

    // Issues (actor comes from the JWT — the backend ignores any body actorId)
    listReceivingMismatches: () => api.get<MismatchListRow[]>("/admin/receiving-mismatches"),
    confirmReceivingMismatch: (itemId: string) =>
      api.post(`/receiving-invoice-items/${itemId}/mismatch/confirm`, {}),
    cancelReceivingMismatch: (itemId: string) =>
      api.post(`/receiving-invoice-items/${itemId}/mismatch/cancel`, {}),
    resolvePickingIssue: (orderId: string, resolutionNote?: string) => {
      const note = (resolutionNote ?? "").trim();
      return api.post(`/picking-orders/${orderId}/resolve-issue`, note ? { resolutionNote: note } : {});
    },
    reportPickingIssue: (
      orderId: string,
      entry: { reason: string; qty?: number; packSize?: number; note?: string; remark?: string }
    ) => api.post(`/picking-orders/report-issues`, { entries: [{ pickingOrderId: orderId, ...entry }] }),
    reportReceivingMismatch: (
      itemId: string,
      body: { reason: string; mismatchQty?: number; wrongPartNo?: string; note?: string }
    ) => api.post(`/receiving-invoice-items/${itemId}/mismatch`, body),
    removeReceivingItem: (itemId: string) => api.del(`/admin/receiving-invoice-items/${itemId}`),

    // Audit logs
    listReceivingOrderLogs: (orderId: string) =>
      api.get<TransactionLogRow[]>(`/admin/receiving-orders/${orderId}/logs`),
    listPickingOrderLogs: (orderId: string) =>
      api.get<TransactionLogRow[]>(`/admin/picking-orders/${orderId}/logs`),

    // Stock search
    stockSearch: (params: { supplierCode?: string; partNo?: string }) => {
      const qs = new URLSearchParams();
      if (params.supplierCode) qs.set("supplierCode", params.supplierCode);
      if (params.partNo) qs.set("partNo", params.partNo);
      return api.get<StockSearchResult>(`/stock-search?${qs}`);
    },

    // Shipping (config-aware feed — the backend picks the source step)
    listShippingOrders: () => api.get<ShippingOrderRow[]>("/shipping-orders"),
    getShippingOrder: (pickingOrderId: string) =>
      api.get<ShippingOrderDetail>(`/shipping-orders/${pickingOrderId}`),
    // Marks each order shipped (POST /shipping-orders/:id/ship). Attempts all
    // ids; on any failure throws an Error whose `failed` property lists the
    // per-order failures ({ id, message }) so callers can surface them.
    shipShippingOrders: async (pickingOrderIds: string[]): Promise<void> => {
      const failed: { id: string; message: string }[] = [];
      for (const id of pickingOrderIds) {
        try {
          await api.post(`/shipping-orders/${id}/ship`);
        } catch (e: any) {
          failed.push({ id, message: e?.message ?? String(e) });
        }
      }
      if (failed.length > 0) {
        const err = new Error(failed.map((f) => `${f.id}: ${f.message}`).join("; "));
        (err as any).failed = failed;
        throw err;
      }
    },
  };
}
