package com.docpal.warehousepda.ui.receiving

import com.docpal.warehousepda.domain.model.ReceivingInvoiceDetail
import com.docpal.warehousepda.domain.model.ReceivingItemDetail
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.domain.model.User
import com.docpal.warehousepda.domain.scan.OcrLabelParser
import com.docpal.warehousepda.domain.scan.ScanMatcher
import com.docpal.warehousepda.domain.scan.ScanPrimitives
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

/** Picking actions + scan wiring on [ReceivingDetailViewModel] (Task 15). */
@OptIn(ExperimentalCoroutinesApi::class)
class ReceivingDetailPickingTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeReceivingSource : ReceivingDetailSource {
        val getOrderDetailCalls = ArrayList<String>()

        override suspend fun getOrderDetail(orderId: String): ReceivingOrderDetail {
            getOrderDetailCalls += orderId
            return detailWith(orderId)
        }

        override suspend fun confirmArrived(orderId: String, actorId: String) {}
    }

    private class FakeMismatchSource : MismatchSource {
        override suspend fun reportMismatch(
            itemId: String, actorId: String, reason: String,
            mismatchQty: Int?, wrongPartNo: String?, note: String,
        ) {}

        override suspend fun editMismatch(
            mismatchId: String, actorId: String, reason: String,
            mismatchQty: Int?, wrongPartNo: String?, note: String,
        ) {}

        override suspend fun confirmMismatch(mismatchId: String, actorId: String) {}
        override suspend fun cancelMismatch(mismatchId: String, actorId: String) {}
    }

    private class FakeSessionSource(var userId: String?) : SessionSource {
        override fun currentUser(): User? =
            userId?.let { User(it, "operator", "Operator", "operator", 0L) }
    }

    private data class ApplyCall(
        val orderId: String, val pickingItemId: String, val qty: Int,
        val dateCode: String?, val lotCode: String?, val coo: String?, val cow: String?,
        val actorId: String,
    )

    private class FakePickingSource : PickingSource {
        val createBoxCalls = ArrayList<Pair<String, String>>()
        val addAllCalls = ArrayList<Pair<String, String>>()
        val applyCalls = ArrayList<ApplyCall>()

        override suspend fun createBox(pickingOrderId: String, actorId: String) {
            createBoxCalls += pickingOrderId to actorId
        }

        override suspend fun addAllToBox(boxId: String, actorId: String) {
            addAllCalls += boxId to actorId
        }

        override suspend fun addPackageToBox(packageId: String, boxId: String, actorId: String) {}
        override suspend fun removePackageFromBox(packageId: String, actorId: String) {}
        override suspend fun removeScannedPackage(packageId: String, actorId: String) {}

        override suspend fun applyOcrPick(
            receivingOrderId: String, pickingItemId: String, qty: Int,
            dateCode: String?, lotCode: String?, coo: String?, cow: String?, actorId: String,
        ) {
            applyCalls += ApplyCall(receivingOrderId, pickingItemId, qty, dateCode, lotCode, coo, cow, actorId)
        }
    }

    private class FakeScanMatchSource : ScanMatchSource {
        var result: ScanMatcher.MatchResult = ScanMatcher.MatchResult.None
        var lastCtx: ScanMatcher.ReceivingContext? = null
        var lastActorId: String? = null

        override suspend fun matchReceiving(
            ctx: ScanMatcher.ReceivingContext,
            parsed: ScanPrimitives.OcrInput,
            actorId: String?,
        ): ScanMatcher.MatchResult {
            lastCtx = ctx
            lastActorId = actorId
            return result
        }
    }

    private class FakeLabelScanParser : LabelScanParser {
        var parseCalls = 0
        var lastCapture: OcrLabelParser.RawOcrCapture? = null

        override suspend fun parse(
            capture: OcrLabelParser.RawOcrCapture,
            targets: List<String>,
        ): OcrLabelParser.OcrParseResult {
            parseCalls++
            lastCapture = capture
            return OcrLabelParser.OcrParseResult(
                matched = false,
                parsed = OcrLabelParser.ParsedFields("IC-1", 5, "CN", "2406", "AB12", "US"),
                options = OcrLabelParser.CandidateOptions(
                    listOf("IC-1"), listOf(5), listOf("CN"),
                    listOf("2406"), listOf("AB12"), listOf("US"),
                ),
                raw = capture,
            )
        }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun vm(
        receiving: FakeReceivingSource = FakeReceivingSource(),
        picking: FakePickingSource = FakePickingSource(),
        matcher: FakeScanMatchSource = FakeScanMatchSource(),
        parser: FakeLabelScanParser = FakeLabelScanParser(),
        session: FakeSessionSource = FakeSessionSource("user-1"),
    ) = ReceivingDetailViewModel(
        orderId = "order-1",
        receivingSource = receiving,
        mismatchSource = FakeMismatchSource(),
        sessionSource = session,
        io = dispatcher,
        pickingSource = picking,
        scanMatchSource = matcher,
        labelScanParser = parser,
    )

    @Test fun `createBox delegates and reloads`() = runTest {
        val receiving = FakeReceivingSource()
        val picking = FakePickingSource()
        val vm = vm(receiving, picking)
        advanceUntilIdle()
        vm.createBox("po-1")
        advanceUntilIdle()
        assertEquals(listOf("po-1" to "user-1"), picking.createBoxCalls)
        // Once on init, once after the mutation.
        assertEquals(listOf("order-1", "order-1"), receiving.getOrderDetailCalls)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `addAllToBox requires confirm flag then delegates`() = runTest {
        val receiving = FakeReceivingSource()
        val picking = FakePickingSource()
        val vm = vm(receiving, picking)
        advanceUntilIdle()

        vm.requestAddAll("box-1")
        assertEquals("box-1", vm.uiState.value.pendingAddAllBoxId)
        assertTrue(picking.addAllCalls.isEmpty())

        vm.confirmAddAll()
        advanceUntilIdle()
        assertEquals(listOf("box-1" to "user-1"), picking.addAllCalls)
        assertNull(vm.uiState.value.pendingAddAllBoxId)
        assertEquals(listOf("order-1", "order-1"), receiving.getOrderDetailCalls)
    }

    @Test fun `applyScan calls applyOcrPick with match fields and reloads`() = runTest {
        val receiving = FakeReceivingSource()
        val picking = FakePickingSource()
        val vm = vm(receiving, picking)
        advanceUntilIdle()
        vm.openManualEntry()

        val match = matchedRecord()
        vm.applyScan(match, ScanPrimitives.OcrInput("IC-1", "2406", "AB12", "CN", "US", "5"))
        advanceUntilIdle()

        assertEquals(
            listOf(ApplyCall("order-1", "pi-1", 5, "2406", "AB12", "CN", "US", "user-1")),
            picking.applyCalls,
        )
        assertEquals("common_scan_success", vm.uiState.value.toastKey)
        assertNull(vm.uiState.value.scanReview)
        assertFalse(vm.uiState.value.dialogOpen)
        assertNull(vm.uiState.value.scanPin)
        assertEquals(listOf("order-1", "order-1"), receiving.getOrderDetailCalls)
    }

    @Test fun `scan pin filters matcher context`() = runTest {
        val matcher = FakeScanMatchSource()
        val vm = vm(matcher = matcher)
        advanceUntilIdle()
        vm.pinScan("pi-1")
        vm.openManualEntry()

        vm.findMatch(ScanPrimitives.OcrInput("IC-1", "", "", "", "", "5"))
        advanceUntilIdle()

        assertEquals("pi-1", matcher.lastCtx?.pickingItemId)
        assertEquals("order-1", matcher.lastCtx?.receivingOrderId)
        assertEquals("user-1", matcher.lastActorId)
    }

    @Test fun `hardware wedge disabled while dialog open`() = runTest {
        val parser = FakeLabelScanParser()
        val vm = vm(parser = parser)
        advanceUntilIdle()

        vm.setDialogOpen(true)
        vm.onHardwareScan("KOA+ABC123")
        advanceUntilIdle()
        assertEquals(0, parser.parseCalls)
        assertNull(vm.uiState.value.scanReview)

        vm.setDialogOpen(false)
        vm.onHardwareScan("KOA+ABC123")
        advanceUntilIdle()
        assertEquals(1, parser.parseCalls)
        val review = vm.uiState.value.scanReview
        assertNotNull(review)
        // No image from a hardware wedge scan -> manual mode (web parity).
        assertTrue(review!!.manual)
        assertEquals("IC-1", review.fields.partNo)
        assertTrue(vm.uiState.value.dialogOpen)
    }

    private companion object {
        fun matchedRecord() = ScanMatcher.MatchedRecord(
            receiving = ScanMatcher.ReceivingCandidate(
                receivingInvoiceItemId = "rii-1", partId = "part-1", partNo = "IC-1",
                dateCode = null, lotCode = null, coo = null, cow = null, availableQty = 100,
            ),
            picking = ScanMatcher.PickingCandidate(
                pickingOrderId = "po-1", pickingOrderRefNo = "PICK-001", pickingItemId = "pi-1",
                partId = "part-1", shipTo = null, requiredQty = 10, pickedQty = 0, remainingQty = 10,
            ),
        )

        fun detailWith(id: String) = ReceivingOrderDetail(
            id = id, refNo = "RO-001", status = "in_hand", deliveryDate = null,
            supplierName = "KOA",
            invoices = listOf(
                ReceivingInvoiceDetail(
                    id = "inv-1", invoiceNo = "INV-1",
                    items = listOf(
                        ReceivingItemDetail(
                            id = "item-1", partId = "part-1", partNo = "IC-1",
                            poNo = null, poLine = null, qty = 10,
                            receivedQty = 10, pickedQty = 0, putAwayQty = 0,
                            boxId = null, dateCode = null, lotCode = null, coo = null, cow = null,
                            allocatedQty = 0, mismatch = null,
                        )
                    ),
                )
            ),
            remainingItems = 1,
            pickingRows = emptyList(), packagesByItem = emptyMap(),
            boxesByOrder = emptyMap(), transitionLogs = emptyMap(),
        )
    }
}
