package com.docpal.warehousepda.ui.picking

import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PickingItemDetail
import com.docpal.warehousepda.domain.model.PickingItemLogEntry
import com.docpal.warehousepda.domain.model.PickingOrderDetail
import com.docpal.warehousepda.domain.model.User
import com.docpal.warehousepda.ui.receiving.SessionSource
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
class PickingDetailViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakePickingDetailSource : PickingDetailSource {
        var detail: PickingOrderDetail = detailWith("po-1")
        var logs: Map<String, List<PickingItemLogEntry>> = emptyMap()
        var throwOnCancelBox: LocalizedException? = null
        val getDetailCalls = ArrayList<String>()
        val finishCalls = ArrayList<Pair<String, String>>()
        val cancelBoxCalls = ArrayList<Pair<String, String>>()
        val addAllCalls = ArrayList<Pair<String, String>>()

        override suspend fun getPickingOrderDetail(orderId: String): PickingOrderDetail? {
            getDetailCalls += orderId
            return detail.copy(id = orderId)
        }

        override suspend fun pickingItemLogs(itemIds: List<String>) = logs

        override suspend fun createBox(pickingOrderId: String, actorId: String) {}

        override suspend fun cancelBox(boxId: String, actorId: String) {
            throwOnCancelBox?.let { throw it }
            cancelBoxCalls += boxId to actorId
        }

        override suspend fun addAllToBox(boxId: String, actorId: String) {
            addAllCalls += boxId to actorId
        }

        override suspend fun addPackageToBox(packageId: String, shippingBoxId: String, actorId: String) {}

        override suspend fun removePackageFromBox(packageId: String, actorId: String) {}

        override suspend fun finishPicking(orderId: String, actorId: String) {
            finishCalls += orderId to actorId
        }

        override suspend fun scanAllocation(allocationId: String, qty: Int, actorId: String) = "pkg-1"

        override suspend fun applyOcrPick(
            receivingOrderId: String, pickingItemId: String, qty: Int,
            dateCode: String?, lotCode: String?, coo: String?, cow: String?, actorId: String,
        ) {}
    }

    private class FakeSessionSource(var userId: String?) : SessionSource {
        override fun currentUser(): User? =
            userId?.let { User(it, "operator", "Operator", "operator", 0L) }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun vm(
        source: FakePickingDetailSource,
        session: FakeSessionSource = FakeSessionSource("user-1"),
        orderId: String = "po-1",
    ) = PickingDetailViewModel(orderId, source, session, dispatcher)

    @Test fun `loads detail and logs on init`() = runTest {
        val source = FakePickingDetailSource().apply {
            logs = mapOf(
                "item-1" to listOf(
                    PickingItemLogEntry(
                        id = "log-1", fromState = "picking", toState = "scanned",
                        actorName = "Operator", metadata = null, createdAt = 0L,
                    )
                )
            )
        }
        val vm = vm(source)
        advanceUntilIdle()
        assertEquals("po-1", vm.uiState.value.detail?.id)
        assertEquals(1, vm.uiState.value.logs["item-1"]?.size)
        assertEquals("user-1", vm.uiState.value.currentUserId)
        assertFalse(vm.uiState.value.loading)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `finish delegates and reloads and toasts when measuring task appears`() = runTest {
        val source = FakePickingDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        // finishPickingOrder creates the measuring task server-side; the reload sees it.
        source.detail = source.detail.copy(measuringTaskId = "task-1")
        vm.finishPicking()
        advanceUntilIdle()
        assertEquals(listOf("po-1" to "user-1"), source.finishCalls)
        // Once on init, once after the mutation.
        assertEquals(listOf("po-1", "po-1"), source.getDetailCalls)
        assertEquals("measuring_task_created", vm.uiState.value.toastKey)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `cancel box delegates and reloads`() = runTest {
        val source = FakePickingDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        vm.cancelBox("box-1")
        advanceUntilIdle()
        assertEquals(listOf("box-1" to "user-1"), source.cancelBoxCalls)
        assertEquals(listOf("po-1", "po-1"), source.getDetailCalls)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `addAll requires confirm then delegates`() = runTest {
        val source = FakePickingDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        vm.requestAddAll("box-1")
        assertEquals("box-1", vm.uiState.value.pendingAddAllBoxId)
        assertEquals(emptyList<Pair<String, String>>(), source.addAllCalls)

        vm.confirmAddAll()
        advanceUntilIdle()
        assertEquals(listOf("box-1" to "user-1"), source.addAllCalls)
        assertNull(vm.uiState.value.pendingAddAllBoxId)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `repository error surfaces as errorKey`() = runTest {
        val source = FakePickingDetailSource().apply {
            throwOnCancelBox = LocalizedException("box_is_not_empty")
        }
        val vm = vm(source)
        advanceUntilIdle()
        vm.cancelBox("box-1")
        advanceUntilIdle()
        assertEquals("box_is_not_empty", vm.uiState.value.errorKey)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `canFinish requires all items boxed and actionable status`() = runTest {
        val source = FakePickingDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        // Fixture item: pickedQty 0 of 10 required.
        assertFalse(vm.uiState.value.canFinish)

        source.detail = source.detail.copy(
            items = source.detail.items.map { it.copy(pickedQty = it.qty) },
        )
        vm.reload()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.canFinish)

        source.detail = source.detail.copy(status = "finished")
        vm.reload()
        advanceUntilIdle()
        assertFalse(vm.uiState.value.canFinish)
    }

    @Test fun `dismissAddAll clears pending without delegating`() = runTest {
        val source = FakePickingDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        vm.requestAddAll("box-1")
        assertEquals("box-1", vm.uiState.value.pendingAddAllBoxId)

        vm.dismissAddAll()
        advanceUntilIdle()
        assertNull(vm.uiState.value.pendingAddAllBoxId)
        assertEquals(emptyList<Pair<String, String>>(), source.addAllCalls)
    }

    private companion object {
        fun detailWith(id: String) = PickingOrderDetail(
            id = id, refNo = "PO-001", status = "picking",
            supplierName = "KOA", supplierCode = "KOA",
            deliveryDate = null, poNo = "PO-1", shipTo = "HK",
            requiredDateCodeNotice = null, measuringTaskId = null,
            issueReason = null, issueQty = null, issuePackSize = null,
            issueNote = null, issueRemark = null, issueReportedByName = null,
            items = listOf(
                PickingItemDetail(
                    id = "item-1", partNo = "IC-1", qty = 10, pickedQty = 0, scannedQty = 0,
                    requiredDateCode = null, allocations = emptyList(), packages = emptyList(),
                )
            ),
            boxes = emptyList(),
        )
    }
}
