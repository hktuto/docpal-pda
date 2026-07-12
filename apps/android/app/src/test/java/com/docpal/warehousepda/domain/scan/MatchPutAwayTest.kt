package com.docpal.warehousepda.domain.scan

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure matcher tests for the put-away task: port of
 * apps/web/composables/useScanMatchers.ts matchPutAway. Plain JVM, no DB.
 */
class MatchPutAwayTest {

    private val pin = ScanMatcher.PinnedPutAwayItem("rii-1", "RK73H1JTTD6201F", 10)

    private fun input(partNo: String = "RK73H1JTTD6201F", qty: String = "4") =
        ScanPrimitives.OcrInput(partNo, "", "", "", "", qty)

    // matchPutAway is pure and never touches the candidate providers.
    private fun matcher() = ScanMatcher(
        receivingCandidates = { _, _, _ -> emptyList() },
        pickingCandidates = { _, _ -> emptyList() },
    )

    @Test
    fun `single when fields match pin`() {
        val result = matcher().matchPutAway(pin, input(), "user-1")
        assertEquals(ScanMatcher.PutAwayMatchResult.Single(pin, 4), result)
    }

    @Test
    fun `part mismatch`() {
        val result = matcher().matchPutAway(pin, input(partNo = "OTHER"), "user-1")
        assertEquals(ScanMatcher.PutAwayMatchResult.Error("scanned_part_does_not_match_item"), result)
    }

    @Test
    fun `qty exceeds available`() {
        val result = matcher().matchPutAway(pin, input(qty = "11"), "user-1")
        assertEquals(ScanMatcher.PutAwayMatchResult.Error("quantity_exceeds_available"), result)
    }

    @Test
    fun `non positive qty`() {
        val result = matcher().matchPutAway(pin, input(qty = "0"), "user-1")
        assertEquals(ScanMatcher.PutAwayMatchResult.Error("qty_must_be_positive_integer"), result)
    }

    @Test
    fun `missing pin`() {
        val result = matcher().matchPutAway(null, input(), "user-1")
        assertEquals(ScanMatcher.PutAwayMatchResult.Error("invalid_receiving_item"), result)
    }

    @Test
    fun `not signed in`() {
        val result = matcher().matchPutAway(pin, input(), null)
        assertEquals(ScanMatcher.PutAwayMatchResult.Error("operator_not_signed_in"), result)
    }
}
