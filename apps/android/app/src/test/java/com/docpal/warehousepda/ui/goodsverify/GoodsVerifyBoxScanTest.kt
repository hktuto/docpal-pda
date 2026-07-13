package com.docpal.warehousepda.ui.goodsverify

import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.User
import com.docpal.warehousepda.domain.model.VerifyBoxDetail
import com.docpal.warehousepda.domain.model.VerifyBoxItem
import com.docpal.warehousepda.domain.scan.OcrLabelParser
import com.docpal.warehousepda.ui.receiving.CameraScanResult
import com.docpal.warehousepda.ui.receiving.SessionSource
import com.docpal.warehousepda.ui.scan.LabelScanParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Scan-to-verify wiring on [GoodsVerifyBoxDetailViewModel] (Task 8). */
@OptIn(ExperimentalCoroutinesApi::class)
class GoodsVerifyBoxScanTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeGoodsVerifyBoxDetailSource : GoodsVerifyBoxDetailSource {
        var detail: VerifyBoxDetail = detailWith("box-1")
        var throwOnVerify: LocalizedException? = null
        // When set, verifyItem flips the item's verified flag so the next reload
        // reports allVerified (the auto-mark path's trigger).
        var flipOnVerify = false
        val getDetailCalls = ArrayList<String>()
        val verifyItemCalls = ArrayList<Pair<String, String>>()
        val markVerifiedCalls = ArrayList<Pair<String, String>>()

        override suspend fun getBoxDetail(boxId: String): VerifyBoxDetail? {
            getDetailCalls += boxId
            return detail.copy(id = boxId)
        }

        override suspend fun verifyItem(boxId: String, partId: String) {
            verifyItemCalls += boxId to partId
            throwOnVerify?.let { throw it }
            if (flipOnVerify) {
                detail = detail.copy(
                    items = detail.items.map {
                        if (it.partId == partId) it.copy(verified = true, verifiedAt = 3000L) else it
                    },
                )
            }
        }

        override suspend fun markBoxVerified(boxId: String, actorId: String) {
            markVerifiedCalls += boxId to actorId
            detail = detail.copy(status = "verified")
        }
    }

    private class FakeSessionSource(var userId: String?) : SessionSource {
        override fun currentUser(): User? =
            userId?.let { User(it, "operator", "Operator", "operator", 0L) }
    }

    private class FakeLabelScanParser : LabelScanParser {
        var parseCalls = 0
        var parsed = OcrLabelParser.ParsedFields("RK73-1", 12, null, null, null, null)

        override suspend fun parse(
            capture: OcrLabelParser.RawOcrCapture,
            targets: List<String>,
        ): OcrLabelParser.OcrParseResult {
            parseCalls++
            return OcrLabelParser.OcrParseResult(
                matched = false,
                parsed = parsed,
                options = OcrLabelParser.CandidateOptions(
                    emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
                ),
                raw = capture,
            )
        }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun vm(
        source: FakeGoodsVerifyBoxDetailSource = FakeGoodsVerifyBoxDetailSource(),
        parser: FakeLabelScanParser = FakeLabelScanParser(),
        session: FakeSessionSource = FakeSessionSource("user-1"),
    ) = GoodsVerifyBoxDetailViewModel("box-1", source, session, dispatcher, parser)

    @Test fun `single match opens review dialog (always confirm)`() = runTest {
        val source = FakeGoodsVerifyBoxDetailSource()
        val vm = vm(source)
        advanceUntilIdle()

        vm.onCameraScan(CameraScanResult("label text", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()

        // Web confirmSingleMatch: a single match does NOT auto-apply — the dialog
        // opens with one pre-selected match option ("{partNo} ({qty})").
        val review = vm.uiState.value.scanReview
        assertNotNull(review)
        assertTrue(vm.uiState.value.dialogOpen)
        assertFalse(review!!.manual)
        assertEquals("/tmp/label.jpg", review.imagePath)
        assertEquals("RK73-1", review.fields.partNo)
        assertEquals("12", review.fields.qty)
        assertEquals(R.string.scan_review_match_single, review.matchMessageRes)
        val option = review.matchOptions.single()
        assertEquals("part-1", option.id)
        assertEquals("RK73-1 (12)", option.label)
        assertEquals(emptyList<Pair<String, String>>(), source.verifyItemCalls)
    }

    @Test fun `apply verifies item and closes dialog`() = runTest {
        val source = FakeGoodsVerifyBoxDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        vm.onCameraScan(CameraScanResult("label text", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()
        val option = vm.uiState.value.scanReview!!.matchOptions.single()

        vm.applyScan(option.id)
        advanceUntilIdle()

        assertEquals(listOf("box-1" to "part-1"), source.verifyItemCalls)
        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        // Once on init, once after the apply.
        assertEquals(listOf("box-1", "box-1"), source.getDetailCalls)
        // The fake doesn't flip the item — still unverified, so no auto-mark.
        assertEquals(emptyList<Pair<String, String>>(), source.markVerifiedCalls)
    }

    @Test fun `match error opens dialog in error state`() = runTest {
        val source = FakeGoodsVerifyBoxDetailSource()
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("OTHER", 1, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()

        vm.onCameraScan(CameraScanResult("ocr noise", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()

        val review = vm.uiState.value.scanReview
        assertNotNull(review)
        assertTrue(vm.uiState.value.dialogOpen)
        // Error state with the parsed fields pre-filled and editable.
        assertEquals("OTHER", review!!.fields.partNo)
        assertEquals(R.string.scan_review_error, review.matchMessageRes)
        assertEquals("part_not_found_in_box", review.matchErrorKey)
        assertTrue(review.matchOptions.isEmpty())
        assertEquals(emptyList<Pair<String, String>>(), source.verifyItemCalls)
    }

    @Test fun `apply failure shows inline error and stays open`() = runTest {
        val source = FakeGoodsVerifyBoxDetailSource().apply {
            throwOnVerify = LocalizedException("shelf_box_item_not_found")
        }
        val vm = vm(source)
        advanceUntilIdle()
        vm.onCameraScan(CameraScanResult("label text", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()
        val option = vm.uiState.value.scanReview!!.matchOptions.single()

        vm.applyScan(option.id)
        advanceUntilIdle()

        assertEquals(listOf("box-1" to "part-1"), source.verifyItemCalls)
        val review = vm.uiState.value.scanReview
        assertNotNull(review)
        assertEquals("shelf_box_item_not_found", review!!.applyErrorKey)
        assertFalse(review.applying)
        assertTrue(vm.uiState.value.dialogOpen)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `auto marks box when last item verified`() = runTest {
        val source = FakeGoodsVerifyBoxDetailSource().apply { flipOnVerify = true }
        val vm = vm(source)
        advanceUntilIdle()
        vm.onCameraScan(CameraScanResult("label text", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()
        val option = vm.uiState.value.scanReview!!.matchOptions.single()

        vm.applyScan(option.id)
        advanceUntilIdle()

        // Verify -> reload shows allVerified -> auto markBoxVerified (web onScanApplied).
        assertEquals(listOf("box-1" to "part-1"), source.verifyItemCalls)
        assertEquals(listOf("box-1" to "user-1"), source.markVerifiedCalls)
        assertEquals("verified", vm.uiState.value.detail?.status)
        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `retake clears dialog`() = runTest {
        val source = FakeGoodsVerifyBoxDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        vm.onCameraScan(CameraScanResult("label text", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.scanReview)

        vm.retakeScan()

        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
    }

    private companion object {
        fun detailWith(id: String) = VerifyBoxDetail(
            id = id, status = "open", shelfCode = "A-01-01", shelfZone = "A",
            items = listOf(
                VerifyBoxItem("part-1", "RK73-1", "Resistor", 12, false, null),
            ),
        )
    }
}
