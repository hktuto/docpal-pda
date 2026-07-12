package com.docpal.warehousepda.domain.scan

import com.docpal.warehousepda.domain.LocalizedException
import kotlinx.coroutines.CancellationException

/** Port of useScanMatchers.matchReceiving (receiving task only; other tasks arrive in later phases). */
class ScanMatcher(
    private val receivingCandidates: suspend (receivingOrderId: String, partNo: String, qty: Int) -> List<ReceivingCandidate>,
    private val pickingCandidates: suspend (receivingOrderId: String, partId: String) -> List<PickingCandidate>,
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

    /** A pinned (or wedge-matched) allocation target on a picking order. */
    data class PinnedAllocation(
        val allocationId: String?,        // null when the item has only a coarse receiving-order allocation target
        val pickingItemId: String,
        val partNo: String,               // normalized (ScanPrimitives.normalize)
        val allocationQty: Int,
        val scannedQty: Int,              // qty already scanned against this allocation
        val receivingOrderId: String?,    // non-null => receiving-order-backed: apply via applyOcrPick
    )

    sealed class PickingMatchResult {
        data class Single(val allocation: PinnedAllocation) : PickingMatchResult()
        data class Error(val key: String) : PickingMatchResult()
    }

    data class MatchedRecord(val receiving: ReceivingCandidate, val picking: PickingCandidate)

    sealed class MatchResult {
        data class Single(val record: MatchedRecord) : MatchResult()
        data class Multiple(val records: List<MatchedRecord>) : MatchResult()
        data object None : MatchResult()
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

            var pickingList = pickingCandidates(receivingOrderId, receiving.partId)
                .filter { it.remainingQty >= p.qty }
            ctx.pickingItemId?.let { pinned ->
                pickingList = pickingList.filter { it.pickingItemId == pinned }
            }
            if (pickingList.isEmpty()) return MatchResult.None

            val records = pickingList.map { MatchedRecord(receiving, it) }
            return if (records.size == 1) MatchResult.Single(records.first()) else MatchResult.Multiple(records)
        } catch (e: LocalizedException) {
            return MatchResult.Error(e.code)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return MatchResult.Error("unknown_match_failed")
        }
    }

    /** Port of useScanMatchers.matchPicking: validates parsed fields against a pinned allocation. */
    fun matchPicking(
        allocation: PinnedAllocation?,
        parsed: ScanPrimitives.OcrInput,
        actorId: String?,
    ): PickingMatchResult {
        if (actorId == null) return PickingMatchResult.Error("operator_not_signed_in")
        if (allocation == null) return PickingMatchResult.Error("missing_allocation")
        val p = try {
            ScanPrimitives.parseManual(parsed)      // throws qty_must_be_positive_integer
        } catch (e: LocalizedException) {
            return PickingMatchResult.Error(e.code)
        }
        if (p.partNo != allocation.partNo) return PickingMatchResult.Error("scanned_part_does_not_match_allocation")
        if (allocation.allocationQty <= 0) return PickingMatchResult.Error("invalid_allocation")
        if (p.qty > allocation.allocationQty) return PickingMatchResult.Error("qty_exceeds_allocated")
        return PickingMatchResult.Single(allocation)
    }

    /**
     * Wedge path: first item whose normalized partNo matches and whose allocation still has room.
     *
     * The web original (picking/[id].vue findMatchingAllocation) checks the *new* scan qty
     * against allocation.qty; here PinnedAllocation.scannedQty is the *cumulative* qty already
     * scanned against the allocation, so "still has room" is scannedQty < allocationQty (a full
     * allocation, scannedQty == allocationQty, is skipped).
     */
    fun findMatchingAllocation(
        parsed: ScanPrimitives.OcrInput,
        allocations: List<PinnedAllocation>,
    ): PinnedAllocation? {
        val p = try { ScanPrimitives.parseManual(parsed) } catch (e: LocalizedException) { return null }
        return allocations.firstOrNull {
            it.partNo == p.partNo && it.allocationQty > 0 && it.scannedQty < it.allocationQty
        }
    }
}
