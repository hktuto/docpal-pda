package com.docpal.warehousepda.ui.putaway

import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PutAwayDetail
import com.docpal.warehousepda.domain.model.PutAwayLotDetail
import com.docpal.warehousepda.domain.model.PutAwayOrderHeader
import com.docpal.warehousepda.domain.model.User
import com.docpal.warehousepda.domain.scan.OcrLabelParser
import com.docpal.warehousepda.domain.scan.ScanPrimitives
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

/** Scan-to-put-away wiring on [PutAwayDetailViewModel] (Task 10). */
@OptIn(ExperimentalCoroutinesApi::class)
class PutAwayDetailScanTest {

    private val dispatcher = StandardTestDispatcher()

    private data class RecordScanCall(
        val receivingInvoiceItemId: String, val qty: Int,
        val dateCode: String?, val lotCode: String?, val coo: String?, val cow: String?,
    )

    private class FakePutAwayDetailSource : PutAwayDetailSource {
        var detail: PutAwayDetail = detailWith("order-1")
        var throwOnScan: LocalizedException? = null
        val getDetailCalls = ArrayList<String>()
        val recordScanCalls = ArrayList<RecordScanCall>()

        override suspend fun getPutAwayDetail(orderId: String): PutAwayDetail {
            getDetailCalls += orderId
            return detail.copy(header = detail.header.copy(id = orderId))
        }

        override suspend fun createBox(orderId: String, shelfCode: String, actorId: String) {}
        override suspend fun assignScanToBox(scanId: String, boxId: String, actorId: String) {}
        override suspend fun addAllToBox(boxId: String, actorId: String) {}
        override suspend fun removeScanFromBox(scanId: String, actorId: String) {}
        override suspend fun removeScannedPiece(scanId: String) {}
        override suspend fun closeBox(boxId: String, actorId: String) {}
        override suspend fun cancelBox(boxId: String, actorId: String) {}

        override suspend fun recordScan(
            receivingInvoiceItemId: String, qty: Int,
            dateCode: String?, lotCode: String?, coo: String?, cow: String?,
        ): String {
            recordScanCalls += RecordScanCall(receivingInvoiceItemId, qty, dateCode, lotCode, coo, cow)
            throwOnScan?.let { throw it }
            return "scan-new"
        }
    }

    private class FakeSessionSource(var userId: String?) : SessionSource {
        override fun currentUser(): User? =
            userId?.let { User(it, "operator", "Operator", "operator", 0L) }
    }

    private class FakeLabelScanParser : LabelScanParser {
        var parseCalls = 0
        var parsed = OcrLabelParser.ParsedFields("IC-1", 4, "CN", "2406", "AB12", "US")

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
        source: FakePutAwayDetailSource = FakePutAwayDetailSource(),
        parser: FakeLabelScanParser = FakeLabelScanParser(),
        session: FakeSessionSource = FakeSessionSource("user-1"),
    ) = PutAwayDetailViewModel("order-1", source, session, dispatcher, parser)

    @Test fun `pinned single match auto applies without dialog`() = runTest {
        val source = FakePutAwayDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        vm.pinLot(source.detail.lots[0])

        vm.onCameraScan(CameraScanResult("label text", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()

        // Fake parser returns partNo IC-1, qty 4 — a single match auto-applies, no dialog.
        // Ancillary fields normalized (normalizeCode for date/lot, normalize for coo/cow).
        assertEquals(
            listOf(RecordScanCall("item-1", 4, "2406", "AB12", "CN", "US")),
            source.recordScanCalls,
        )
        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        assertNull(vm.uiState.value.scanPin)
        assertEquals("common_scan_success", vm.uiState.value.toastKey)
        // Once on init, once after the apply.
        assertEquals(listOf("order-1", "order-1"), source.getDetailCalls)
    }

    @Test fun `match error opens review dialog`() = runTest {
        val source = FakePutAwayDetailSource()
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("OTHER", 4, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()
        vm.pinLot(source.detail.lots[0])

        vm.onCameraScan(CameraScanResult("ocr noise", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()

        val review = vm.uiState.value.scanReview
        assertNotNull(review)
        assertTrue(vm.uiState.value.dialogOpen)
        // Camera review mode (imagePath != null) with the parsed fields pre-filled.
        assertFalse(review!!.manual)
        assertEquals("/tmp/label.jpg", review.imagePath)
        assertEquals("OTHER", review.fields.partNo)
        assertEquals("4", review.fields.qty)
        assertEquals(R.string.scan_review_error, review.matchMessageRes)
        assertEquals("scanned_part_does_not_match_item", review.matchErrorKey)
        assertEquals(emptyList<RecordScanCall>(), source.recordScanCalls)
    }

    @Test fun `review dialog find match then apply`() = runTest {
        val source = FakePutAwayDetailSource()
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("OTHER", 4, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()
        vm.pinLot(source.detail.lots[0])
        vm.onCameraScan(CameraScanResult("ocr noise", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.scanReview)

        vm.updateScanFields(ScanPrimitives.OcrInput("IC-1", "", "", "", "", "4"))
        vm.findMatch()
        advanceUntilIdle()

        val matched = vm.uiState.value.scanReview!!
        assertEquals(R.string.scan_review_match_single, matched.matchMessageRes)
        assertEquals(1, matched.matchOptions.size)
        val option = matched.matchOptions.single()
        assertEquals("IC-1 (4)", option.label)

        vm.applyScan(option.id)
        advanceUntilIdle()

        assertEquals(
            listOf(RecordScanCall("item-1", 4, null, null, null, null)),
            source.recordScanCalls,
        )
        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        assertNull(vm.uiState.value.scanPin)
        assertEquals("common_scan_success", vm.uiState.value.toastKey)
    }

    @Test fun `auto apply error toasts without dialog`() = runTest {
        val source = FakePutAwayDetailSource().apply {
            throwOnScan = LocalizedException("scanned_qty_exceeds_total")
        }
        val vm = vm(source)
        advanceUntilIdle()
        vm.pinLot(source.detail.lots[0])

        vm.onCameraScan(CameraScanResult("label text", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()

        assertEquals(
            listOf(RecordScanCall("item-1", 4, "2406", "AB12", "CN", "US")),
            source.recordScanCalls,
        )
        // No dialog surface in the auto-apply path — the error is toasted instead.
        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        assertEquals("scanned_qty_exceeds_total", vm.uiState.value.toastKey)
        assertEquals(emptyList<String>(), vm.uiState.value.toastArgs)
        // The pin survives so the operator can retry the scan.
        assertEquals("item-1", vm.uiState.value.scanPin?.receivingInvoiceItemId)
    }

    @Test fun `dialog apply failure shows inline error and stays open`() = runTest {
        val source = FakePutAwayDetailSource().apply {
            throwOnScan = LocalizedException("scanned_qty_exceeds_total")
        }
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("OTHER", 4, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()
        vm.pinLot(source.detail.lots[0])
        vm.onCameraScan(CameraScanResult("ocr noise", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.scanReview)

        vm.updateScanFields(ScanPrimitives.OcrInput("IC-1", "", "", "", "", "4"))
        vm.findMatch()
        advanceUntilIdle()
        val option = vm.uiState.value.scanReview!!.matchOptions.single()

        vm.applyScan(option.id)
        advanceUntilIdle()

        // The fake was called once, the dialog stays open with the inline error.
        assertEquals(
            listOf(RecordScanCall("item-1", 4, null, null, null, null)),
            source.recordScanCalls,
        )
        val review = vm.uiState.value.scanReview
        assertNotNull(review)
        assertEquals("scanned_qty_exceeds_total", review!!.applyErrorKey)
        assertFalse(review.applying)
        assertTrue(vm.uiState.value.dialogOpen)
        assertNull(vm.uiState.value.toastKey)
    }

    @Test fun `retake keeps pin and clears dialog`() = runTest {
        val source = FakePutAwayDetailSource()
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("OTHER", 4, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()
        vm.pinLot(source.detail.lots[0])
        vm.onCameraScan(CameraScanResult("ocr noise", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()
        // Camera review mode (imagePath != null) — retake is offered.
        assertFalse(vm.uiState.value.scanReview!!.manual)

        vm.retakeScan()

        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        // The pin survives: the re-scan matches the same lot.
        assertEquals("item-1", vm.uiState.value.scanPin?.receivingInvoiceItemId)
    }

    private companion object {
        fun detailWith(id: String) = PutAwayDetail(
            header = PutAwayOrderHeader(
                id = id, refNo = "RO-001", status = "in_hand",
                supplierName = "KOA", supplierCode = "KOA", deliveryDate = null,
            ),
            lots = listOf(
                PutAwayLotDetail(
                    receivingInvoiceItemId = "item-1", partNo = "IC-1",
                    dateCode = null, lotCode = null, coo = null, cow = null,
                    totalQty = 10, availableQty = 10, scannedQty = 0, boxedQty = 0,
                )
            ),
            scans = emptyList(),
            boxes = emptyList(),
            shelves = emptyList(),
        )
    }
}
