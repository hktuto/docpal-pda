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
