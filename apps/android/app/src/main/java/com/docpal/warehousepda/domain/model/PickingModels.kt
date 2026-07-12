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
