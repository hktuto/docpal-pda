package com.docpal.warehousepda.ui.receiving

import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.MismatchInfo
import com.docpal.warehousepda.domain.model.ReceivingInvoiceDetail
import com.docpal.warehousepda.domain.model.ReceivingItemDetail
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.domain.model.User
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ReceivingDetailViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeReceivingSource : ReceivingDetailSource {
        var detail: ReceivingOrderDetail = detailWith("order-1")
        var throwOnConfirm: LocalizedException? = null
        val getOrderDetailCalls = ArrayList<String>()
        val confirmArrivedCalls = ArrayList<Pair<String, String>>()

        override suspend fun getOrderDetail(orderId: String): ReceivingOrderDetail {
            getOrderDetailCalls += orderId
            return detail.copy(id = orderId)
        }

        override suspend fun confirmArrived(orderId: String, actorId: String) {
            throwOnConfirm?.let { throw it }
            confirmArrivedCalls += orderId to actorId
        }
    }

    private data class ReportCall(
        val itemId: String, val reason: String, val qty: Int?, val wrongPart: String?, val note: String,
    )

    private data class EditCall(
        val mismatchId: String, val actorId: String, val reason: String,
        val qty: Int?, val wrongPart: String?, val note: String,
    )

    private class FakeMismatchSource : MismatchSource {
        var throwOnReport: LocalizedException? = null
        val reportCalls = ArrayList<ReportCall>()
        val editCalls = ArrayList<EditCall>()
        val confirmCalls = ArrayList<Pair<String, String>>()
        val cancelCalls = ArrayList<Pair<String, String>>()

        override suspend fun reportMismatch(
            itemId: String, actorId: String, reason: String,
            mismatchQty: Int?, wrongPartNo: String?, note: String,
        ) {
            throwOnReport?.let { throw it }
            reportCalls += ReportCall(itemId, reason, mismatchQty, wrongPartNo, note)
        }

        override suspend fun editMismatch(
            mismatchId: String, actorId: String, reason: String,
            mismatchQty: Int?, wrongPartNo: String?, note: String,
        ) {
            editCalls += EditCall(mismatchId, actorId, reason, mismatchQty, wrongPartNo, note)
        }

        override suspend fun confirmMismatch(mismatchId: String, actorId: String) {
            confirmCalls += mismatchId to actorId
        }

        override suspend fun cancelMismatch(mismatchId: String, actorId: String) {
            cancelCalls += mismatchId to actorId
        }
    }

    private class FakeSessionSource(var userId: String?) : SessionSource {
        override fun currentUser(): User? =
            userId?.let { User(it, "operator", "Operator", "operator", 0L) }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun vm(
        receiving: FakeReceivingSource,
        mismatch: FakeMismatchSource = FakeMismatchSource(),
        session: FakeSessionSource = FakeSessionSource("user-1"),
        orderId: String = "order-1",
    ) = ReceivingDetailViewModel(orderId, receiving, mismatch, session, dispatcher)

    @Test fun `loads detail on init`() = runTest {
        val receiving = FakeReceivingSource()
        val vm = vm(receiving)
        advanceUntilIdle()
        assertEquals("order-1", vm.uiState.value.detail?.id)
        assertEquals("user-1", vm.uiState.value.currentUserId)
        assertFalse(vm.uiState.value.loading)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `confirmArrived calls repository and reloads`() = runTest {
        val receiving = FakeReceivingSource()
        val vm = vm(receiving)
        advanceUntilIdle()
        vm.confirmArrived()
        advanceUntilIdle()
        assertEquals(listOf("order-1" to "user-1"), receiving.confirmArrivedCalls)
        // Once on init, once after the mutation.
        assertEquals(listOf("order-1", "order-1"), receiving.getOrderDetailCalls)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `repository error surfaces as errorKey`() = runTest {
        val receiving = FakeReceivingSource()
        val mismatch = FakeMismatchSource().apply {
            throwOnReport = LocalizedException("pending_mismatch_already_exists")
        }
        val vm = vm(receiving, mismatch)
        advanceUntilIdle()
        vm.reportMismatch("item-1", "damaged", 2, null, "note")
        advanceUntilIdle()
        assertEquals("pending_mismatch_already_exists", vm.uiState.value.errorKey)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `confirmArrived error params surface as errorArgs`() = runTest {
        val receiving = FakeReceivingSource().apply {
            throwOnConfirm =
                LocalizedException("receiving_order_already_status", mapOf("status" to "in_hand"))
        }
        val vm = vm(receiving)
        advanceUntilIdle()
        vm.confirmArrived()
        advanceUntilIdle()
        val state = vm.uiState.value
        assertEquals("receiving_order_already_status", state.errorKey)
        assertEquals(listOf("in_hand"), state.errorArgs)
        assertFalse(state.actionInProgress)
    }

    @Test fun `mismatch error params surface as errorArgs`() = runTest {
        val receiving = FakeReceivingSource()
        val mismatch = FakeMismatchSource().apply {
            throwOnReport =
                LocalizedException("unhandled_mismatch_reason", mapOf("reason" to "bogus"))
        }
        val vm = vm(receiving, mismatch)
        advanceUntilIdle()
        vm.reportMismatch("item-1", "bogus", null, null, "note")
        advanceUntilIdle()
        val state = vm.uiState.value
        assertEquals("unhandled_mismatch_reason", state.errorKey)
        assertEquals(listOf("bogus"), state.errorArgs)
    }

    @Test fun `errorArgs are cleared with the error`() = runTest {
        val receiving = FakeReceivingSource()
        val mismatch = FakeMismatchSource().apply {
            throwOnReport =
                LocalizedException("unhandled_mismatch_reason", mapOf("reason" to "bogus"))
        }
        val vm = vm(receiving, mismatch)
        advanceUntilIdle()
        vm.reportMismatch("item-1", "bogus", null, null, "note")
        advanceUntilIdle()
        assertEquals(listOf("bogus"), vm.uiState.value.errorArgs)

        vm.clearError()
        assertNull(vm.uiState.value.errorKey)
        assertEquals(emptyList<String>(), vm.uiState.value.errorArgs)
    }

    @Test fun `four eyes - reporter sees edit, others see confirm-cancel`() = runTest {
        val pendingMismatch = mismatch(id = "m-1", reportedBy = "user-1")
        val receiving = FakeReceivingSource().apply {
            detail = detailWith("order-1", mismatch = pendingMismatch)
        }

        val reporterVm = vm(receiving, session = FakeSessionSource("user-1"))
        advanceUntilIdle()
        val reporterMismatch = reporterVm.uiState.value.detail!!.invoices[0].items[0].mismatch!!
        assertTrue(reporterVm.canEditMismatch(reporterMismatch))
        assertFalse(reporterVm.canReviewMismatch(reporterMismatch))

        val otherVm = vm(receiving, session = FakeSessionSource("user-2"))
        advanceUntilIdle()
        val otherMismatch = otherVm.uiState.value.detail!!.invoices[0].items[0].mismatch!!
        assertFalse(otherVm.canEditMismatch(otherMismatch))
        assertTrue(otherVm.canReviewMismatch(otherMismatch))
    }

    @Test fun `reportMismatch success records call, reloads, no error`() = runTest {
        val receiving = FakeReceivingSource()
        val mismatch = FakeMismatchSource()
        val vm = vm(receiving, mismatch)
        advanceUntilIdle()
        vm.reportMismatch("item-1", "damaged", 2, null, "note")
        advanceUntilIdle()
        assertEquals(listOf(ReportCall("item-1", "damaged", 2, null, "note")), mismatch.reportCalls)
        // Once on init, once after the mutation.
        assertEquals(listOf("order-1", "order-1"), receiving.getOrderDetailCalls)
        assertNull(vm.uiState.value.errorKey)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `errorKey is cleared by the next successful action`() = runTest {
        val receiving = FakeReceivingSource()
        val mismatch = FakeMismatchSource().apply {
            throwOnReport = LocalizedException("pending_mismatch_already_exists")
        }
        val vm = vm(receiving, mismatch)
        advanceUntilIdle()
        vm.reportMismatch("item-1", "damaged", 2, null, "note")
        advanceUntilIdle()
        assertEquals("pending_mismatch_already_exists", vm.uiState.value.errorKey)

        mismatch.throwOnReport = null
        vm.reportMismatch("item-1", "damaged", 2, null, "note")
        advanceUntilIdle()
        assertNull(vm.uiState.value.errorKey)
        assertEquals(1, mismatch.reportCalls.size)
    }

    @Test fun `editMismatch passes mismatch id and actor`() = runTest {
        val receiving = FakeReceivingSource()
        val mismatch = FakeMismatchSource()
        val vm = vm(receiving, mismatch)
        advanceUntilIdle()
        vm.editMismatch("m-9", "wrong_part", 3, "PART-X", "note")
        advanceUntilIdle()
        assertEquals(
            listOf(EditCall("m-9", "user-1", "wrong_part", 3, "PART-X", "note")),
            mismatch.editCalls,
        )
    }

    @Test fun `confirm and cancel mismatch pass mismatch id and actor`() = runTest {
        val receiving = FakeReceivingSource()
        val mismatch = FakeMismatchSource()
        val vm = vm(receiving, mismatch)
        advanceUntilIdle()
        vm.confirmMismatch("m-1")
        advanceUntilIdle()
        vm.cancelMismatch("m-2")
        advanceUntilIdle()
        assertEquals(listOf("m-1" to "user-1"), mismatch.confirmCalls)
        assertEquals(listOf("m-2" to "user-1"), mismatch.cancelCalls)
    }

    private companion object {
        fun mismatch(id: String, reportedBy: String, status: String = "pending") = MismatchInfo(
            id = id, reason = "damaged", mismatchQty = 2, wrongPartNo = null, note = null,
            status = status, effectiveReceivedQty = 8, previousReceivedQty = 10,
            reportedBy = reportedBy, reportedAt = 0L,
        )

        fun detailWith(id: String, mismatch: MismatchInfo? = null) = ReceivingOrderDetail(
            id = id, refNo = "RO-001", status = "pending", deliveryDate = null,
            supplierName = "KOA",
            invoices = listOf(
                ReceivingInvoiceDetail(
                    id = "inv-1", invoiceNo = "INV-1",
                    items = listOf(
                        ReceivingItemDetail(
                            id = "item-1", partId = "part-1", partNo = "IC-1",
                            poNo = "PO-1", poLine = "10", qty = 10,
                            receivedQty = 0, pickedQty = 0, putAwayQty = 0,
                            boxId = null, dateCode = null, lotCode = null, coo = null, cow = null,
                            allocatedQty = 0, mismatch = mismatch,
                        )
                    ),
                )
            ),
            remainingItems = 0,
            pickingRows = emptyList(), packagesByItem = emptyMap(),
            boxesByOrder = emptyMap(), transitionLogs = emptyMap(),
        )
    }
}
