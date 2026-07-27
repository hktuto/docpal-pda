/**
 * Typed wrappers over useApi for the backend's flow endpoints (non-`/admin`
 * reads the console needs: picking / receiving / measuring) plus the admin
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
}

export interface PickingItemRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  pickedQty: number;
  allocatedQty: number;
  allocations: {
    id: string;
    qty: number;
    boxId: string | null;
    receivingInvoiceItemId: string | null;
    receivingOrderId: string | null;
    lot: { id: string; shelfCode: string | null; boxId: string | null; dateCode: string | null; lotCode: string | null } | null;
  }[];
  packages: { id: string; qty: number; dateCode: string | null; lotCode: string | null; verified: boolean; shippingBoxId: string | null }[];
}

export interface PickingOrderDetail extends Omit<PickingOrderRow, "itemCount" | "totalQty" | "pickedQty" | "prioritySeq" | "workingBy" | "workingByName"> {
  measuringTask: { id: string; status: string } | null;
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
    items: ReceivingItemRow[];
  }[];
}

// ---- measuring (shipping) ----

export interface MeasuringTaskRow {
  id: string;
  status: string;
  pickingOrderId: string;
  orderNo: string;
  shipTo: string | null;
  boxCount: number;
  closedBoxCount: number;
  createdAt: string;
}

export interface MeasuringTaskDetail {
  task: { id: string; status: string; pickingOrderId: string; createdAt: string };
  order: { id: string; orderNo: string; status: string; shipTo: string | null; customerCode: string | null; poNo: string | null };
  boxes: {
    id: string;
    status: string;
    boxSize: string | null;
    grossWeight: number | null;
    netWeight: number | null;
    destinationCountry: string | null;
    packages: { id: string; qty: number; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null; verified: boolean; partNo: string; wclItemNo: string | null }[];
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

    // Stock search
    stockSearch: (params: { supplierId?: string; partNo?: string }) => {
      const qs = new URLSearchParams();
      if (params.supplierId) qs.set("supplierId", params.supplierId);
      if (params.partNo) qs.set("partNo", params.partNo);
      return api.get<StockSearchResult>(`/stock-search?${qs}`);
    },

    // Measuring (shipping)
    listMeasuringTasks: (status?: string) =>
      api.get<MeasuringTaskRow[]>(`/measuring-tasks${status ? `?status=${status}` : ""}`),
    getMeasuringTask: (id: string) => api.get<MeasuringTaskDetail>(`/measuring-tasks/${id}`),
  };
}
