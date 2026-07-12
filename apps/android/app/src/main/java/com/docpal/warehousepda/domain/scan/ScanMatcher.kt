package com.docpal.warehousepda.domain.scan

import com.docpal.warehousepda.domain.LocalizedException

/** Port of useScanMatchers.matchReceiving (receiving task only; other tasks arrive in later phases). */
class ScanMatcher(
    private val receivingCandidates: suspend (receivingOrderId: String, partNo: String, qty: Int) -> List<ReceivingCandidate>,
    private val pickingCandidates: suspend (receivingOrderId: String, partId: String, qty: Int) -> List<PickingCandidate>,
) {

    data class ReceivingCandidate(
        val receivingInvoiceItemId: String,
        val partId: String,
        val partNo: String,
        val dateCode: String?,
        val lotCode: String?,
        val coo: String?,
        val cow: String?,
        val availableQty: Int,
    )

    data class PickingCandidate(
        val pickingOrderId: String,
        val pickingOrderRefNo: String,
        val pickingItemId: String,
        val partId: String,
        val shipTo: String?,
        val requiredQty: Int,
        val pickedQty: Int,
        val remainingQty: Int,
    )

    data class ReceivingContext(
        val receivingOrderId: String?,
        val pickingItemId: String?,   // pinned item filter
    )

    data class MatchedRecord(val receiving: ReceivingCandidate, val picking: PickingCandidate)

    sealed class MatchResult {
        data class Single(val record: MatchedRecord) : MatchResult()
        data class Multiple(val records: List<MatchedRecord>) : MatchResult()
        object None : MatchResult()
        data class Error(val key: String) : MatchResult()
    }

    suspend fun matchReceiving(
        ctx: ReceivingContext,
        parsed: ScanPrimitives.OcrInput,
        actorId: String?,
    ): MatchResult {
        try {
            if (actorId == null) return MatchResult.Error("operator_not_signed_in")
            val receivingOrderId = ctx.receivingOrderId ?: return MatchResult.Error("missing_receiving_order_id")
            val p = ScanPrimitives.parseManual(parsed)

            val receivingList = receivingCandidates(receivingOrderId, p.partNo, p.qty)
            if (receivingList.isEmpty()) return MatchResult.None
            val receiving = receivingList.first()
            if (p.qty > receiving.availableQty) return MatchResult.None

            var pickingList = pickingCandidates(receivingOrderId, receiving.partId, p.qty)
                .filter { it.remainingQty >= p.qty }
            ctx.pickingItemId?.let { pinned ->
                pickingList = pickingList.filter { it.pickingItemId == pinned }
            }
            if (pickingList.isEmpty()) return MatchResult.None

            val records = pickingList.map { MatchedRecord(receiving, it) }
            return if (records.size == 1) MatchResult.Single(records.first()) else MatchResult.Multiple(records)
        } catch (e: LocalizedException) {
            return MatchResult.Error(e.code)
        } catch (e: Exception) {
            return MatchResult.Error("unknown_match_failed")
        }
    }
}
