package com.docpal.warehousepda.domain.model

data class ReceivingOrderSummary(
    val id: String,
    val refNo: String,
    val status: String,
    val deliveryDate: Long?,
    val supplierName: String?,
    val remainingItems: Int,
    val pendingPickingOrders: Int,
)

data class MismatchInfo(
    val id: String,
    val reason: String,
    val mismatchQty: Int?,
    val wrongPartNo: String?,
    val note: String?,
    val status: String,
    val effectiveReceivedQty: Int,
    val previousReceivedQty: Int,
    val reportedBy: String?,
    val reportedAt: Long,
)

data class ReceivingItemDetail(
    val id: String,
    val partId: String,
    val partNo: String,
    val poNo: String?,
    val poLine: String?,
    val qty: Int,
    val receivedQty: Int,
    val pickedQty: Int,
    val putAwayQty: Int,
    val boxId: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
    val allocatedQty: Int,       // from AllocationDistributor
    val mismatch: MismatchInfo?,
) {
    val availableQty: Int get() = receivedQty - pickedQty - putAwayQty - allocatedQty
}

data class ReceivingInvoiceDetail(
    val id: String,
    val invoiceNo: String,
    val items: List<ReceivingItemDetail>,
)

data class PickingByReceivingRow(
    val pickingOrderId: String,
    val pickingOrderRef: String,
    val pickingOrderStatus: String,
    val pickingOrderShipTo: String?,
    val pickingItemId: String,
    val requiredQty: Int,
    val pickedQty: Int,
    val scannedQty: Int,
    val boxedQty: Int,
    val partId: String,
    val partNo: String,
    val shelfCode: String?,
    val boxId: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
    val allocatedQty: Int,
    val allocationId: String,
)

data class DisplayPackage(
    val id: String,
    val pickingItemId: String,
    val pickingOrderId: String,
    val qty: Int,
    val shippingBoxId: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
    val createdAt: Long,
)

data class DisplayBox(
    val id: String,
    val pickingOrderId: String?,
    val status: String,
)

data class PickingItemLog(
    val id: String,
    val entityId: String,
    val fromState: String?,
    val toState: String,
    val metadata: String?,
    val createdAt: Long,
    val actorName: String?,
)

data class ReceivingOrderDetail(
    val id: String,
    val refNo: String,
    val status: String,
    val deliveryDate: Long?,
    val supplierName: String?,
    val invoices: List<ReceivingInvoiceDetail>,
    val remainingItems: Int,
    val pickingRows: List<PickingByReceivingRow>,
    val packagesByItem: Map<String, List<DisplayPackage>>,
    val boxesByOrder: Map<String, List<DisplayBox>>,
    val transitionLogs: Map<String, List<PickingItemLog>>,
)
