package com.docpal.warehousepda.domain.scan

import com.docpal.warehousepda.domain.LocalizedException
import kotlinx.coroutines.CancellationException

/** Ports of useScanMatchers: matchReceiving, matchPicking, matchPutAway. */
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
        /** qty is the validated scan quantity from parseManual. */
        data class Single(val allocation: PinnedAllocation, val qty: Int) : PickingMatchResult()
        data class Error(val key: String) : PickingMatchResult()
    }

    /** A pinned put-away target: one receiving invoice item (lot card). */
    data class PinnedPutAwayItem(
        val receivingInvoiceItemId: String,
        val partNo: String,               // normalized (ScanPrimitives.normalize)
        val availableQty: Int,            // live-computed remaining for this item
    )

    sealed class PutAwayMatchResult {
        /** qty is the validated scan quantity from parseManual. */
        data class Single(val item: PinnedPutAwayItem, val qty: Int) : PutAwayMatchResult()
        data class Error(val key: String) : PutAwayMatchResult()
    }

    /** An unverified item in the box being verified (aggregation key is part). */
    data class GoodsVerifyTarget(
        val partId: String,
        val partNo: String,               // normalized (ScanPrimitives.normalize)
        val qty: Int,                     // aggregated box qty for display
    )

    sealed class GoodsVerifyMatchResult {
        data class Single(val item: GoodsVerifyTarget) : GoodsVerifyMatchResult()
        data class Error(val key: String) : GoodsVerifyMatchResult()
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

    /**
     * Port of useScanMatchers.matchPicking: validates parsed fields against a pinned allocation.
     * On success, Single carries the validated scan quantity (qty) alongside the allocation.
     */
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
        return PickingMatchResult.Single(allocation, p.qty)
    }

    /**
     * Port of useScanMatchers.matchPutAway: validates parsed fields against the pinned lot.
     * On success, Single carries the validated scan quantity (qty) alongside the pinned item.
     * Date/lot/coo/cow are not validated (web parity — taken from the label as-is at apply time).
     */
    fun matchPutAway(
        item: PinnedPutAwayItem?,
        parsed: ScanPrimitives.OcrInput,
        actorId: String?,
    ): PutAwayMatchResult {
        if (actorId == null) return PutAwayMatchResult.Error("operator_not_signed_in")
        if (item == null) return PutAwayMatchResult.Error("invalid_receiving_item")
        val p = try {
            ScanPrimitives.parseManual(parsed)      // throws qty_must_be_positive_integer
        } catch (e: LocalizedException) {
            return PutAwayMatchResult.Error(e.code)
        }
        if (p.partNo != item.partNo) return PutAwayMatchResult.Error("scanned_part_does_not_match_item")
        if (p.qty > item.availableQty) return PutAwayMatchResult.Error("quantity_exceeds_available")
        return PutAwayMatchResult.Single(item, p.qty)
    }

    /** Port of useScanMatchers.matchGoodsVerify: matches the scanned part against the box's unverified items. */
    fun matchGoodsVerify(
        targets: List<GoodsVerifyTarget>,       // unverified items only
        parsed: ScanPrimitives.OcrInput,
        actorId: String?,
    ): GoodsVerifyMatchResult {
        if (actorId == null) return GoodsVerifyMatchResult.Error("operator_not_signed_in")
        val partNo = ScanPrimitives.normalize(parsed.partNo)
        if (partNo.isEmpty()) return GoodsVerifyMatchResult.Error("part_no_required")
        val item = targets.firstOrNull { it.partNo == partNo }
            ?: return GoodsVerifyMatchResult.Error("part_not_found_in_box")
        return GoodsVerifyMatchResult.Single(item)
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
