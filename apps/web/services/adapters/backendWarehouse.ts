import type {
  ReceivingFilter,
  ReceivingOrderListRow,
  ReceivingOrderDetail,
  ReceivingPickingSection,
  ReceivingScanInput,
  ReceivingScanResult,
  ReceivingItemMismatch,
  ReportMismatchInput,
  PickingOrderListRow,
  PickingOrderDetail,
  PickingWorkLock,
  ScanPickingItemInput,
  ShippingBoxUpdateInput,
  ReportPickingIssueEntry,
  ReportPickingIssuesResult,
  PutAwayCandidate,
  PutAwayDetail,
  PutAwayScan,
  ShelfBox,
  Shelf,
  MeasuringTaskListRow,
  MeasuringTaskDetail,
  VerifyTaskListRow,
  VerifyTaskDetail,
  FlowConfig,
  GoodsVerifyTaskListRow,
  GoodsVerifyTaskDetail,
  GoodsVerifyTaskFilters,
  StockSearchFilters,
  StockSearchResult,
  SupplierListRow,
  SupplierQrcodeTemplate,
  BoxSearchResult,
  LabelsData,
} from "../types";
import type { WarehouseService } from "../warehouse";
import { createApiClient } from "../apiClient";

export interface CreateBackendWarehouseServiceOptions {
  apiBaseUrl?: string;
}

/** Backend scan-templates row (GET /scan-templates). */
interface ScanTemplateRow {
  supplierCode: string;
  qrTemplate: string | null;
  qtyEncoding: string | null;
}

/**
 * WarehouseService implementation talking to apps/backend (:3002).
 *
 * Step 2 (receiving flow): receiving list/detail/confirm-arrival, the nested
 * picking section, server-side receiving scans, the item-keyed mismatch
 * lifecycle, and scan templates are real HTTP calls. Step 3 (put-away flow):
 * candidates, the one aggregate detail read, staging-scan recording, box
 * membership/lifecycle verbs, and the shelf list are real HTTP calls.
 * Step 4 (picking flow): list/detail reads, scan-to-pick, package removal,
 * the shared shipping-box verbs (create/update/membership/add-all/cancel/
 * close), package verification, finish, and batch issue reports are real
 * HTTP calls. Step 5 (measuring flow): task list, the consolidated
 * task/order/boxes detail, and task completion are real HTTP calls (box
 * measurement itself reuses the step-4 verbs). Step 6 (goods verify flow):
 * day-end task generation, the task queue reads, and per-task verify are
 * real HTTP calls. Step 7 (stock search): the one aggregate
 * `/stock-search` read plus the admin suppliers dropdown list are real
 * HTTP calls — every flow is now migrated (see docs/backend/api-design.md).
 * Step 8 (verify flow): task list/detail/complete plus the closed-box reopen
 * are real HTTP calls, and GET /config exposes the env-driven flow-step
 * toggles.
 *
 * Auth: every request carries `Authorization: Bearer <token>` (wired in
 * apiClient via the shared token getter); the server derives the actor from
 * the JWT, so mutation bodies no longer send actorId.
 */
export function createBackendWarehouseService(
  options: CreateBackendWarehouseServiceOptions
): WarehouseService {
  const client = createApiClient({ baseUrl: options.apiBaseUrl ?? "" });

  return {
    // Receiving
    async getReceivingOrders(
      filter: ReceivingFilter
    ): Promise<ReceivingOrderListRow[]> {
      return client.get("/receiving-orders", {
        status: filter === "all" ? undefined : filter,
      });
    },
    async getReceivingOrder(id: string): Promise<ReceivingOrderDetail> {
      return client.get(`/receiving-orders/${id}`);
    },
    async confirmReceivingOrderArrived(id: string): Promise<void> {
      await client.post(`/receiving-orders/${id}/confirm-arrival`, {});
    },
    // Server-side parse/match. A 409 {message: no_match|multiple_matches,
    // candidates} propagates as an ApiError with the parsed body — the caller
    // surfaces the candidates in the review modal.
    async scanReceiving(
      orderId: string,
      input: ReceivingScanInput
    ): Promise<ReceivingScanResult> {
      return client.post(`/receiving-orders/${orderId}/scan`, { ...input });
    },

    // Mismatches (item-keyed)
    async getActiveMismatch(
      itemId: string
    ): Promise<ReceivingItemMismatch | null> {
      return client.get(`/receiving-invoice-items/${itemId}/mismatch`);
    },
    async reportMismatch(
      itemId: string,
      input: ReportMismatchInput
    ): Promise<void> {
      await client.post(`/receiving-invoice-items/${itemId}/mismatch`, {
        ...input,
      });
    },
    async editMismatch(
      itemId: string,
      input: ReportMismatchInput
    ): Promise<void> {
      await client.patch(`/receiving-invoice-items/${itemId}/mismatch`, {
        ...input,
      });
    },
    async confirmMismatch(itemId: string): Promise<void> {
      await client.post(`/receiving-invoice-items/${itemId}/mismatch/confirm`, {});
    },
    async cancelMismatch(itemId: string): Promise<void> {
      await client.post(`/receiving-invoice-items/${itemId}/mismatch/cancel`, {});
    },

    // Picking (receiving detail view)
    async getPickingOrdersByReceivingOrder(
      id: string
    ): Promise<ReceivingPickingSection> {
      return client.get(`/receiving-orders/${id}/picking`);
    },

    // Picking — list + nested detail, then the mutation verbs in design-doc
    // order. Allocation ids are unstable after scans (allocateAll rebuilds
    // them), so callers must re-fetch the detail rather than cache ids.
    async getPickingOrders(status?: string): Promise<PickingOrderListRow[]> {
      return client.get("/picking-orders", { status });
    },
    async getPickingOrder(id: string): Promise<PickingOrderDetail> {
      return client.get(`/picking-orders/${id}`);
    },
    // The one canonical scan-to-pick (covers lot and receiving-area sources;
    // the old applyOcrPick path is gone). Null batch fields are omitted so the
    // source's own attrs win.
    async scanPickingItem(
      itemId: string,
      input: ScanPickingItemInput
    ): Promise<{ packageIds: string[] }> {
      return client.post(`/picking-items/${itemId}/scan`, {
        allocationId: input.allocationId,
        qty: input.qty,
        dateCode: input.dateCode ?? undefined,
        lotCode: input.lotCode ?? undefined,
        coo: input.coo ?? undefined,
        cow: input.cow ?? undefined,
      });
    },
    // Remove an unboxed, unverified package (reverses source + allocation).
    async removeScannedPackage(packageId: string): Promise<void> {
      await client.del(`/packages/${packageId}`);
    },
    // Whole-box exact-match claim: the shelf carton becomes the (prefilled)
    // shipping box with all packages already inside.
    async claimShelfBox(
      orderId: string,
      shelfBoxId: string
    ): Promise<{ shippingBoxId: string; packageIds: string[] }> {
      return client.post(`/picking-orders/${orderId}/claim-shelf-box`, { shelfBoxId });
    },
    // Measuring-time package verification (boxed, open box, pending task).
    async verifyPackage(packageId: string): Promise<void> {
      await client.post(`/packages/${packageId}/verify`, {});
    },
    async createShippingBoxForPickingOrder(
      pickingOrderId: string,
      boxId?: string
    ): Promise<void> {
      await client.post(`/picking-orders/${pickingOrderId}/boxes`, {
        boxId: boxId?.trim() || undefined,
      });
    },
    // Box size / weights (kg) / destination country; open boxes only.
    async updateShippingBox(
      id: string,
      fields: ShippingBoxUpdateInput
    ): Promise<void> {
      await client.patch(`/shipping-boxes/${id}`, { ...fields });
    },
    async addPackageToBox(packageId: string, boxId: string): Promise<void> {
      await client.post(`/shipping-boxes/${boxId}/packages`, { packageId });
    },
    async removePackageFromBox(boxId: string, packageId: string): Promise<void> {
      await client.del(`/shipping-boxes/${boxId}/packages/${packageId}`);
    },
    async addAllUnboxedPackagesToBox(boxId: string): Promise<number> {
      const result = await client.post<{ packed: number }>(
        `/shipping-boxes/${boxId}/add-all-unboxed`,
        {}
      );
      return result.packed;
    },
    async cancelShippingBox(id: string): Promise<void> {
      await client.post(`/shipping-boxes/${id}/cancel`, {});
    },
    async closeShippingBox(id: string): Promise<void> {
      await client.post(`/shipping-boxes/${id}/close`, {});
    },
    // Explicit finish: all items fully boxed → order finished + the measuring
    // task (returned). Boxing the last package also auto-finishes.
    async finishPickingOrder(
      id: string
    ): Promise<{ id: string; pickingOrderId: string; status: string }> {
      return client.post(`/picking-orders/${id}/finish`, {});
    },
    // Batch issue report: per-order entries (the dialog's shared fields are
    // already folded into each entry by the caller).
    async reportPickingOrderIssues(
      entries: ReportPickingIssueEntry[]
    ): Promise<ReportPickingIssuesResult> {
      return client.post(`/picking-orders/report-issues`, { entries });
    },

    async acquirePickingWorkLock(id: string): Promise<PickingWorkLock> {
      return client.post(`/picking-orders/${id}/work-lock`);
    },
    releasePickingWorkLock(id: string): void {
      client.keepaliveDel(`/picking-orders/${id}/work-lock`);
    },

    // Put-away — one aggregate read (order + expected items + materialized
    // lots + staging scans + boxes), per-verb mutations. Scan label matching
    // stays client-side (see useScanMatchers.matchPutAway).
    async getPutAwayCandidates(): Promise<PutAwayCandidate[]> {
      return client.get("/put-away/candidates");
    },
    async getPutAwayDetail(receivingOrderId: string): Promise<PutAwayDetail> {
      return client.get(`/receiving-orders/${receivingOrderId}/put-away`);
    },
    // The admin CRUD read doubles as the PDA shelf list.
    async getShelves(): Promise<Shelf[]> {
      return client.get("/admin/shelves");
    },
    async recordPutAwayScan(
      receivingOrderId: string,
      receivingInvoiceItemId: string,
      qty: number,
      dateCode: string | null,
      lotCode: string | null,
      coo: string | null,
      cow: string | null,
      shelfBoxId?: string | null
    ): Promise<PutAwayScan> {
      return client.post(`/receiving-orders/${receivingOrderId}/put-away-scans`, {
        receivingInvoiceItemId,
        qty,
        dateCode: dateCode ?? undefined,
        lotCode: lotCode ?? undefined,
        coo: coo ?? undefined,
        cow: cow ?? undefined,
        shelfBoxId: shelfBoxId ?? undefined,
      });
    },
    async assignPutAwayScanToBox(
      scanId: string,
      boxId: string
    ): Promise<void> {
      await client.post(`/shelf-boxes/${boxId}/scans`, { scanId });
    },
    async addAllUnboxedScansToBox(boxId: string): Promise<number> {
      const result = await client.post<{ count: number }>(
        `/shelf-boxes/${boxId}/add-all-unboxed`,
        {}
      );
      return result.count;
    },
    async removePutAwayScanFromBox(
      scanId: string,
      boxId: string
    ): Promise<void> {
      await client.del(`/shelf-boxes/${boxId}/scans/${scanId}`);
    },
    // Hard-delete a staged scan (mis-scan correction); boxed scans go through
    // removePutAwayScanFromBox instead (backend: 409 scan_not_in_staging_box).
    async removePutAwayScannedPiece(scanId: string): Promise<void> {
      await client.del(`/put-away-scans/${scanId}`);
    },
    async createShelfBox(
      receivingOrderId: string,
      shelfCode: string,
      boxId?: string
    ): Promise<ShelfBox> {
      return client.post("/shelf-boxes", {
        receivingOrderId,
        shelfCode,
        boxId: boxId ?? undefined,
      });
    },
    async closeShelfBox(id: string): Promise<void> {
      await client.post(`/shelf-boxes/${id}/close`, {});
    },
    async cancelShelfBox(id: string): Promise<void> {
      await client.del(`/shelf-boxes/${id}`);
    },

    // Measuring — list/detail reads plus completion. Box measurement
    // reuses the shared picking verbs above (verifyPackage /
    // updateShippingBox / closeShippingBox); scanned labels are matched
    // to packages client-side from the consolidated detail.
    async getMeasuringTasks(status?: string): Promise<MeasuringTaskListRow[]> {
      return client.get("/measuring-tasks", { status });
    },
    async getMeasuringTask(id: string): Promise<MeasuringTaskDetail> {
      return client.get(`/measuring-tasks/${id}`);
    },
    async completeMeasuringTask(id: string): Promise<void> {
      await client.post(`/measuring-tasks/${id}/complete`, {});
    },

    // Verify — list/detail reads plus completion, mirroring measuring.
    // Reopen is the verify-step-only escape hatch: closed box → open,
    // packages un-verified, so the worker can re-measure and re-close.
    async getVerifyTasks(status?: string): Promise<VerifyTaskListRow[]> {
      return client.get("/verify-tasks", { status });
    },
    async getVerifyTask(id: string): Promise<VerifyTaskDetail> {
      return client.get(`/verify-tasks/${id}`);
    },
    async completeVerifyTask(id: string): Promise<void> {
      await client.post(`/verify-tasks/${id}/complete`, {});
    },
    async reopenShippingBox(boxId: string): Promise<void> {
      await client.post(`/shipping-boxes/${boxId}/reopen`, {});
    },

    // Flow-step config (GET /config) — env-driven, read once after login.
    async getFlowConfig(): Promise<FlowConfig> {
      return client.get("/config");
    },

    // Goods verify — tasks are generated by the backend day-end cron job (no
    // client trigger); these are the task queue reads and the one-call
    // per-task verify. A countedQty that differs from expectedQty corrects
    // the lot and writes an ADJUST ledger row server-side
    // (409 counted_qty_below_allocated / goods_verify_task_not_pending /
    // shelf_box_not_closed).
    async getGoodsVerifyTasks(
      filters: GoodsVerifyTaskFilters = {}
    ): Promise<GoodsVerifyTaskListRow[]> {
      return client.get("/goods-verify-tasks", {
        date: filters.date,
        status: filters.status,
        shelfCode: filters.shelfCode,
      });
    },
    async getGoodsVerifyTask(id: string): Promise<GoodsVerifyTaskDetail> {
      return client.get(`/goods-verify-tasks/${id}`);
    },
    async verifyGoodsVerifyTask(
      id: string,
      countedQty?: number
    ): Promise<GoodsVerifyTaskListRow> {
      return client.post(`/goods-verify-tasks/${id}/verify`, { countedQty });
    },

    // Supplier QR templates for client-side label parsing
    async getSupplierQrTemplates(): Promise<SupplierQrcodeTemplate[]> {
      const rows = await client.get<ScanTemplateRow[]>("/scan-templates");
      return rows.map((row) => ({
        code: row.supplierCode,
        qrcodeTemplate: row.qrTemplate ?? "",
        qrcodeQtyEncoding: row.qtyEncoding,
      }));
    },

    // Demo reset (dev only) — the one method that works from step 1 on.
    async resetDemoData(): Promise<void> {
      await client.post("/dev/reset");
    },

    // Stock search — one aggregate read; filters are optional ANDed query
    // params. Zero-qty lots come back by design.
    async searchStock(
      filters: StockSearchFilters = {}
    ): Promise<StockSearchResult> {
      return client.get("/stock-search", {
        supplierCode: filters.supplierCode,
        partNo: filters.partNo,
        shelfCode: filters.shelfCode,
      });
    },
    // The admin suppliers CRUD read doubles as the PDA supplier dropdown
    // (same trick as getShelves).
    async getSuppliers(): Promise<SupplierListRow[]> {
      return client.get("/admin/suppliers");
    },

    // Box lookup for the /box QR page (shipping + shelf boxes, id substring).
    async searchBoxes(q: string): Promise<BoxSearchResult[]> {
      return client.get("/boxes", { q });
    },

    // Printable labels for the /print-labels page. The 60 s GET cache is
    // bypassed so a just-received / just-put-away world shows up immediately.
    async getLabelsData(): Promise<LabelsData> {
      return client.get("/labels-data", { t: Date.now() });
    },
  };
}
