package com.docpal.warehousepda.domain.model

/** Put-away list row (web PutAwayCandidate from listPutAwayCandidates, putAway.ts). */
data class PutAwayCandidate(
    val orderId: String,
    val refNo: String,
    val status: String,           // always "in_hand" (query filter)
    val supplierName: String?,
    val availableQty: Int,        // sum of per-item availability, clamped >= 0 per item
)
