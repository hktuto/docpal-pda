package com.docpal.warehousepda.domain.model

/** Goods-verify shelf list row (web getShelvesWithBoxes, goodsVerify.ts): every shelf with its box count. */
data class ShelfSummary(
    val code: String,
    val zone: String?,
    val boxCount: Int,
)

/** Box summary on a shelf (web getShelfBoxesByShelf): per-part verify progress + last check time. */
data class VerifyBoxSummary(
    val id: String,
    val status: String,
    val itemCount: Int,        // distinct parts with scans in the box
    val verifiedCount: Int,    // parts whose scans are ALL verified
    val lastCheckAt: Long?,    // max verified_at, epoch ms
    val checkedToday: Boolean, // lastCheckAt on the current UTC date
)

/** Box detail item (web getShelfBoxDetail items): one part's aggregated scans in the box. */
data class VerifyBoxItem(
    val partId: String,
    val partNo: String,
    val description: String?,
    val qty: Int,              // SUM(qty) over the box's scans for this part
    val verified: Boolean,     // MIN(verified) == 1 (web bool_and(verified))
    val verifiedAt: Long?,     // MAX(verified_at), epoch ms
)

/** Box detail read model (web getShelfBoxDetail): header + per-part items. */
data class VerifyBoxDetail(
    val id: String,
    val status: String,
    val shelfCode: String?,
    val shelfZone: String?,
    val items: List<VerifyBoxItem>,
) {
    val allVerified: Boolean get() = items.isNotEmpty() && items.all { it.verified }
}
