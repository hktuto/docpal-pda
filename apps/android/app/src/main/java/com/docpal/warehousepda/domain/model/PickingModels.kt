package com.docpal.warehousepda.domain.model

data class PickingOrderSummary(
    val id: String,
    val refNo: String,
    val status: String,
    val deliveryDate: Long?,
    val supplierName: String?,
    val shipTo: String?,
    val totalQty: Int,
)

/** Input for PickingRepository.reportPickingOrderIssues (web PickingOrderIssueInput). */
data class PickingIssueInput(
    val reason: String,     // insufficient_stock | cannot_divide | merge | other
    val qty: Int?,          // required for insufficient_stock
    val packSize: Int?,     // required for cannot_divide
    val note: String?,
)

/** Picking detail screen read model (web PickingOrderDetail from getPickingOrderDetail, picking.ts). */
data class PickingOrderDetail(
    val id: String,
    val refNo: String,
    val status: String,
    val supplierName: String?,
    val supplierCode: String?,          // scan context (join suppliers)
    val deliveryDate: Long?,
    val poNo: String?,
    val shipTo: String?,
    val requiredDateCodeNotice: String?,
    val measuringTaskId: String?,
    // issue fields (banner when status == "issue")
    val issueReason: String?,
    val issueQty: Int?,
    val issuePackSize: Int?,
    val issueNote: String?,
    val issueRemark: String?,
    val issueReportedByName: String?,   // join users
    val items: List<PickingItemDetail>,
    val boxes: List<PickingBoxDetail>,
)

data class PickingItemDetail(
    val id: String,
    val partNo: String?,
    val qty: Int,
    val pickedQty: Int,                 // boxed-only total (entity field)
    val scannedQty: Int,                // SUM of ALL its packages' qty (computed)
    val requiredDateCode: String?,
    val allocations: List<PickingAllocationDetail>,  // qty > 0 only
    val packages: List<PickingPackageDetail>,
)

data class PickingAllocationDetail(
    val id: String,
    val qty: Int,
    // inventory-lot-backed (allocations.inventory_lot_id set):
    val lotId: String?,
    val shelfCode: String?,
    val boxId: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
    // receiving-order-backed (allocations.receiving_order_id set):
    val receivingOrderId: String?,
    val receivingOrderRefNo: String?,
    val boxIds: List<String>,           // parsed from allocations.remark JSON array of strings; empty on any parse failure
)

data class PickingPackageDetail(
    val id: String,
    val qty: Int,
    val shippingBoxId: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
)

data class PickingBoxDetail(
    val id: String,
    val status: String,
    val packageCount: Int,
    val totalQty: Int,                  // SUM of its packages' qty
)

/** Picking-item transition log row (web PickingItemTransitionLog from getPickingItemTransitionLogs). */
data class PickingItemLogEntry(
    val id: String,
    val fromState: String?,
    val toState: String?,
    val actorName: String?,
    val metadata: String?,
    val createdAt: Long,
)
