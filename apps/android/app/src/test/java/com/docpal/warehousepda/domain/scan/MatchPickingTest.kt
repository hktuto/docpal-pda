package com.docpal.warehousepda.domain.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure matcher tests for the picking task: ports of
 * apps/web/composables/useScanMatchers.ts matchPicking and
 * apps/web/pages/picking/[id].vue findMatchingAllocation. Plain JVM, no DB.
 */
class MatchPickingTest {

    private val pin = ScanMatcher.PinnedAllocation("alloc-1", "pi-1", "IC-LM358DR", 10, 0, null)

    private fun input(partNo: String = "IC-LM358DR", qty: String = "4") =
        ScanPrimitives.OcrInput(partNo, "", "", "", "", qty)

    // The new picking functions are pure and never touch the candidate providers.
    private fun matcher() = ScanMatcher(
        receivingCandidates = { _, _, _ -> emptyList() },
        pickingCandidates = { _, _ -> emptyList() },
    )

    @Test
    fun `single when fields match pin`() {
        val result = matcher().matchPicking(pin, input(), "user-1")
        assertEquals(ScanMatcher.PickingMatchResult.Single(pin), result)
    }

    @Test
    fun `part mismatch`() {
        val result = matcher().matchPicking(pin, input(partNo = "OTHER"), "user-1")
        assertEquals(ScanMatcher.PickingMatchResult.Error("scanned_part_does_not_match_allocation"), result)
    }

    @Test
    fun `qty exceeds allocated`() {
        val result = matcher().matchPicking(pin, input(qty = "11"), "user-1")
        assertEquals(ScanMatcher.PickingMatchResult.Error("qty_exceeds_allocated"), result)
    }

    @Test
    fun `non positive qty`() {
        val result = matcher().matchPicking(pin, input(qty = "0"), "user-1")
        assertEquals(ScanMatcher.PickingMatchResult.Error("qty_must_be_positive_integer"), result)
    }

    @Test
    fun `missing allocation`() {
        val result = matcher().matchPicking(null, input(), "user-1")
        assertEquals(ScanMatcher.PickingMatchResult.Error("missing_allocation"), result)
    }

    @Test
    fun `not signed in`() {
        val result = matcher().matchPicking(pin, input(), null)
        assertEquals(ScanMatcher.PickingMatchResult.Error("operator_not_signed_in"), result)
    }

    @Test
    fun `findMatchingAllocation picks first matching with room`() {
        val full = ScanMatcher.PinnedAllocation("alloc-1", "pi-1", "IC-LM358DR", 10, 10, null)
        val room = ScanMatcher.PinnedAllocation("alloc-2", "pi-2", "IC-LM358DR", 10, 0, null)
        val result = matcher().findMatchingAllocation(input(), listOf(full, room))
        assertEquals(room, result)
    }

    @Test
    fun `findMatchingAllocation null on no match`() {
        val result = matcher().findMatchingAllocation(input(partNo = "NOPE"), listOf(pin))
        assertNull(result)
    }
}
