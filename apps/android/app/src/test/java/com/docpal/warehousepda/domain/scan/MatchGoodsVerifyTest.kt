package com.docpal.warehousepda.domain.scan

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure matcher tests for the goods-verify task: port of
 * apps/web/composables/useScanMatchers.ts matchGoodsVerify. Plain JVM, no DB.
 */
class MatchGoodsVerifyTest {

    private val targets = listOf(ScanMatcher.GoodsVerifyTarget("part-1", "RK73H1JTTD6201F", 12))

    private fun input(partNo: String = "RK73H1JTTD6201F") =
        ScanPrimitives.OcrInput(partNo, "", "", "", "", "")

    // matchGoodsVerify is pure and never touches the candidate providers.
    private fun matcher() = ScanMatcher(
        receivingCandidates = { _, _, _ -> emptyList() },
        pickingCandidates = { _, _ -> emptyList() },
    )

    @Test
    fun `single when part matches an unverified item`() {
        val result = matcher().matchGoodsVerify(targets, input(), "user-1")
        assertEquals(ScanMatcher.GoodsVerifyMatchResult.Single(targets[0]), result)
    }

    @Test
    fun `match is normalized`() {
        val result = matcher().matchGoodsVerify(targets, input(partNo = "  rk73h1jttd6201f  "), "user-1")
        assertEquals(ScanMatcher.GoodsVerifyMatchResult.Single(targets[0]), result)
    }

    @Test
    fun `empty part`() {
        val result = matcher().matchGoodsVerify(targets, input(partNo = ""), "user-1")
        assertEquals(ScanMatcher.GoodsVerifyMatchResult.Error("part_no_required"), result)
    }

    @Test
    fun `part not in box`() {
        val result = matcher().matchGoodsVerify(targets, input(partNo = "OTHER"), "user-1")
        assertEquals(ScanMatcher.GoodsVerifyMatchResult.Error("part_not_found_in_box"), result)
    }

    @Test
    fun `already verified part not in targets`() {
        val result = matcher().matchGoodsVerify(emptyList(), input(), "user-1")
        assertEquals(ScanMatcher.GoodsVerifyMatchResult.Error("part_not_found_in_box"), result)
    }

    @Test
    fun `not signed in`() {
        val result = matcher().matchGoodsVerify(targets, input(), null)
        assertEquals(ScanMatcher.GoodsVerifyMatchResult.Error("operator_not_signed_in"), result)
    }
}
