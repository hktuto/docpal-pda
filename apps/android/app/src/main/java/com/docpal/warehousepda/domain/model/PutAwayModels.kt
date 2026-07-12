package com.docpal.warehousepda.domain.model

/** Put-away list row (web PutAwayCandidate from listPutAwayCandidates, putAway.ts). */
data class PutAwayCandidate(
    val orderId: String,
    val refNo: String,
    val status: String,           // always "in_hand" (query filter)
    val supplierName: String?,
    val availableQty: Int,        // sum of per-item availability, clamped >= 0 per item
)

/** Put-away detail header: receiving order + supplier fields shown on the detail page. */
data class PutAwayOrderHeader(
    val id: String,
    val refNo: String,
    val status: String,
    val supplierName: String?,
    val supplierCode: String?,
    val deliveryDate: Long?,      // epoch millis, same as ReceivingOrderDetail/PickingOrderDetail
)

/** Put-away lot row (web getPutAwayLots HAVING survivor): one invoice item with live availability. */
data class PutAwayLotDetail(
    val receivingInvoiceItemId: String,
    val partNo: String?,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
    val totalQty: Int,            // invoice item qty
    val availableQty: Int,        // ReceivingAvailability per-item available, clamped >= 0 (as in listCandidates)
    val scannedQty: Int,          // SUM of all put_away_scans qty for this item
    val boxedQty: Int,            // SUM of scan qty where shelf_box_id IS NOT NULL
)

data class PutAwayScanDetail(
    val id: String,
    val receivingInvoiceItemId: String,
    val qty: Int,
    val dateCode: String?,
    val lotCode: String?,
    val coo: String?,
    val cow: String?,
    val shelfBoxId: String?,
)

data class PutAwayBoxDetail(
    val id: String,
    val shelfCode: String?,
    val zone: String?,
    val status: String,
    val createdAt: Long,
    val lineCount: Int,           // scans in box
    val totalQty: Int,            // SUM of scan qty in box
    val contents: List<PutAwayBoxContent>,  // per-part aggregation, filled by repository
)

data class PutAwayBoxContent(
    val partNo: String?,
    val qty: Int,
)

data class ShelfOption(
    val code: String,
    val zone: String?,
)

/** Put-away detail read model (web put-away detail page data: lots + scans + boxes + shelf options). */
data class PutAwayDetail(
    val header: PutAwayOrderHeader,
    val lots: List<PutAwayLotDetail>,   // empty unless header.status == "in_hand" (web parity)
    val scans: List<PutAwayScanDetail>,
    val boxes: List<PutAwayBoxDetail>,
    val shelves: List<ShelfOption>,
)
