package com.docpal.warehousepda.ui.picking

import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PickingAllocationDetail
import com.docpal.warehousepda.domain.model.PickingItemDetail
import com.docpal.warehousepda.domain.model.PickingItemLogEntry
import com.docpal.warehousepda.domain.model.PickingOrderDetail
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

/** Scan-to-pick wiring on [PickingDetailViewModel] (Task 10). */
@OptIn(ExperimentalCoroutinesApi::class)
class PickingDetailScanTest {

    private val dispatcher = StandardTestDispatcher()

    private data class ScanCall(val allocationId: String, val qty: Int, val actorId: String)

    private data class OcrPickCall(
        val receivingOrderId: String, val pickingItemId: String, val qty: Int,
        val dateCode: String?, val lotCode: String?, val coo: String?, val cow: String?,
        val actorId: String,
    )

    private class FakePickingDetailSource : PickingDetailSource {
        var detail: PickingOrderDetail = detailWith()
        var throwOnScan: LocalizedException? = null
        val getDetailCalls = ArrayList<String>()
        val scanCalls = ArrayList<ScanCall>()
        val ocrPickCalls = ArrayList<OcrPickCall>()

        override suspend fun getPickingOrderDetail(orderId: String): PickingOrderDetail? {
            getDetailCalls += orderId
            return detail.copy(id = orderId)
        }

        override suspend fun pickingItemLogs(itemIds: List<String>) =
            emptyMap<String, List<PickingItemLogEntry>>()

        override suspend fun createBox(pickingOrderId: String, actorId: String) {}
        override suspend fun cancelBox(boxId: String, actorId: String) {}
        override suspend fun addAllToBox(boxId: String, actorId: String) {}
        override suspend fun addPackageToBox(packageId: String, shippingBoxId: String, actorId: String) {}
        override suspend fun removePackageFromBox(packageId: String, actorId: String) {}
        override suspend fun finishPicking(orderId: String, actorId: String) {}

        override suspend fun scanAllocation(allocationId: String, qty: Int, actorId: String): String {
            scanCalls += ScanCall(allocationId, qty, actorId)
            throwOnScan?.let { throw it }
            return "pkg-1"
        }

        override suspend fun applyOcrPick(
            receivingOrderId: String, pickingItemId: String, qty: Int,
            dateCode: String?, lotCode: String?, coo: String?, cow: String?, actorId: String,
        ) {
            ocrPickCalls +=
                OcrPickCall(receivingOrderId, pickingItemId, qty, dateCode, lotCode, coo, cow, actorId)
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
        source: FakePickingDetailSource = FakePickingDetailSource(),
        parser: FakeLabelScanParser = FakeLabelScanParser(),
        session: FakeSessionSource = FakeSessionSource("user-1"),
    ) = PickingDetailViewModel("po-1", source, session, dispatcher, parser)

    @Test fun `pinned single match auto applies to lot allocation without dialog`() = runTest {
        val source = FakePickingDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        val item = source.detail.items[0]
        vm.pinAllocation(item.allocations[0], item)

        vm.onCameraScan(CameraScanResult("label text", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()

        // Fake parser returns partNo IC-1, qty 4 — a single match auto-applies, no dialog.
        assertEquals(listOf(ScanCall("alloc-1", 4, "user-1")), source.scanCalls)
        assertEquals(emptyList<OcrPickCall>(), source.ocrPickCalls)
        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        assertNull(vm.uiState.value.scanPin)
        assertEquals("common_scan_success", vm.uiState.value.toastKey)
        // Once on init, once after the apply.
        assertEquals(listOf("po-1", "po-1"), source.getDetailCalls)
    }

    @Test fun `pinned receiving allocation applies via applyOcrPick`() = runTest {
        val source = FakePickingDetailSource().apply {
            detail = detailWith(allocations = listOf(receivingAllocation()))
        }
        val vm = vm(source)
        advanceUntilIdle()
        val item = source.detail.items[0]
        vm.pinAllocation(item.allocations[0], item)

        vm.onCameraScan(CameraScanResult("label text", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()

        assertEquals(emptyList<ScanCall>(), source.scanCalls)
        assertEquals(
            listOf(OcrPickCall("ro-1", "item-1", 4, "2406", "AB12", "CN", "US", "user-1")),
            source.ocrPickCalls,
        )
        assertEquals("common_scan_success", vm.uiState.value.toastKey)
    }

    @Test fun `match error opens review dialog`() = runTest {
        val source = FakePickingDetailSource()
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("OTHER", 4, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()
        val item = source.detail.items[0]
        vm.pinAllocation(item.allocations[0], item)

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
        assertEquals("scanned_part_does_not_match_allocation", review.matchErrorKey)
        assertEquals(emptyList<ScanCall>(), source.scanCalls)
    }

    @Test fun `review dialog find match then apply`() = runTest {
        val source = FakePickingDetailSource()
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("OTHER", 4, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()
        val item = source.detail.items[0]
        vm.pinAllocation(item.allocations[0], item)
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

        assertEquals(listOf(ScanCall("alloc-1", 4, "user-1")), source.scanCalls)
        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        assertNull(vm.uiState.value.scanPin)
        assertEquals("common_scan_success", vm.uiState.value.toastKey)
    }

    @Test fun `wedge without pin matches allocation by part`() = runTest {
        val source = FakePickingDetailSource()
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("IC-1", 2, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()

        vm.onHardwareScan("IC-1 2")
        advanceUntilIdle()

        // The IC-1 allocation is pinned implicitly and the match auto-applies.
        assertEquals(listOf(ScanCall("alloc-1", 2, "user-1")), source.scanCalls)
        assertEquals("common_scan_success", vm.uiState.value.toastKey)
    }

    @Test fun `wedge without pin no match toasts`() = runTest {
        val source = FakePickingDetailSource()
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("UNKNOWN", 2, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()

        vm.onHardwareScan("UNKNOWN 2")
        advanceUntilIdle()

        assertEquals("picking_detail_no_matching_allocation", vm.uiState.value.toastKey)
        assertEquals(emptyList<ScanCall>(), source.scanCalls)
        assertEquals(emptyList<OcrPickCall>(), source.ocrPickCalls)
        assertNull(vm.uiState.value.scanPin)
    }

    @Test fun `wedge ignored while dialog open`() = runTest {
        val source = FakePickingDetailSource()
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("OTHER", 4, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()
        val item = source.detail.items[0]
        vm.pinAllocation(item.allocations[0], item)
        vm.onCameraScan(CameraScanResult("ocr noise", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()
        assertTrue(vm.uiState.value.dialogOpen)
        val callsBefore = parser.parseCalls

        vm.onHardwareScan("IC-1 2")
        advanceUntilIdle()

        assertEquals(callsBefore, parser.parseCalls)
        assertEquals(emptyList<ScanCall>(), source.scanCalls)
    }

    @Test fun `auto apply error toasts without dialog`() = runTest {
        val source = FakePickingDetailSource().apply {
            throwOnScan = LocalizedException("allocation_not_found", mapOf("detail" to "alloc-1"))
        }
        val vm = vm(source)
        advanceUntilIdle()
        val item = source.detail.items[0]
        vm.pinAllocation(item.allocations[0], item)

        vm.onCameraScan(CameraScanResult("label text", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()

        assertEquals(listOf(ScanCall("alloc-1", 4, "user-1")), source.scanCalls)
        // No dialog surface in the auto-apply path — the error is toasted instead.
        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        assertEquals("allocation_not_found", vm.uiState.value.toastKey)
        assertEquals(listOf("alloc-1"), vm.uiState.value.toastArgs)
        // The pin survives so the operator can retry the scan.
        assertEquals("alloc-1", vm.uiState.value.scanPin?.allocationId)
    }

    @Test fun `dialog apply failure shows inline error and stays open`() = runTest {
        val source = FakePickingDetailSource().apply {
            throwOnScan = LocalizedException("allocation_not_found")
        }
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("OTHER", 4, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()
        val item = source.detail.items[0]
        vm.pinAllocation(item.allocations[0], item)
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
        assertEquals(listOf(ScanCall("alloc-1", 4, "user-1")), source.scanCalls)
        val review = vm.uiState.value.scanReview
        assertNotNull(review)
        assertEquals("allocation_not_found", review!!.applyErrorKey)
        assertFalse(review.applying)
        assertTrue(vm.uiState.value.dialogOpen)
        assertNull(vm.uiState.value.toastKey)
    }

    @Test fun `retake keeps pin and clears dialog`() = runTest {
        val source = FakePickingDetailSource()
        val parser = FakeLabelScanParser().apply {
            parsed = OcrLabelParser.ParsedFields("OTHER", 4, null, null, null, null)
        }
        val vm = vm(source, parser)
        advanceUntilIdle()
        val item = source.detail.items[0]
        vm.pinAllocation(item.allocations[0], item)
        vm.onCameraScan(CameraScanResult("ocr noise", emptyList(), "/tmp/label.jpg"))
        advanceUntilIdle()
        // Camera review mode (imagePath != null) — retake is offered.
        assertFalse(vm.uiState.value.scanReview!!.manual)

        vm.retakeScan()

        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        // The pin survives: the re-scan matches the same allocation.
        assertEquals("alloc-1", vm.uiState.value.scanPin?.allocationId)
    }

    private companion object {
        fun lotAllocation(id: String = "alloc-1", qty: Int = 10) = PickingAllocationDetail(
            id = id, qty = qty,
            lotId = "lot-1", shelfCode = "A1", boxId = null,
            dateCode = "2406", lotCode = "AB12", coo = "CN", cow = "US",
            receivingOrderId = null, receivingOrderRefNo = null, boxIds = emptyList(),
        )

        fun receivingAllocation(id: String = "alloc-2", qty: Int = 10) = PickingAllocationDetail(
            id = id, qty = qty,
            lotId = null, shelfCode = null, boxId = null,
            dateCode = null, lotCode = null, coo = null, cow = null,
            receivingOrderId = "ro-1", receivingOrderRefNo = "RO-1", boxIds = emptyList(),
        )

        fun detailWith(
            allocations: List<PickingAllocationDetail> = listOf(lotAllocation()),
        ) = PickingOrderDetail(
            id = "po-1", refNo = "PO-001", status = "picking",
            supplierName = "KOA", supplierCode = "KOA",
            deliveryDate = null, poNo = "PO-1", shipTo = "HK",
            requiredDateCodeNotice = null, measuringTaskId = null,
            issueReason = null, issueQty = null, issuePackSize = null,
            issueNote = null, issueRemark = null, issueReportedByName = null,
            items = listOf(
                PickingItemDetail(
                    id = "item-1", partNo = "IC-1", qty = 10, pickedQty = 0, scannedQty = 0,
                    requiredDateCode = null, allocations = allocations, packages = emptyList(),
                )
            ),
            boxes = emptyList(),
        )
    }
}
