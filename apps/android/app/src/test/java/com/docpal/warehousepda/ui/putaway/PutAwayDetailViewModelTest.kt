package com.docpal.warehousepda.ui.putaway

import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PutAwayBoxDetail
import com.docpal.warehousepda.domain.model.PutAwayDetail
import com.docpal.warehousepda.domain.model.PutAwayLotDetail
import com.docpal.warehousepda.domain.model.PutAwayOrderHeader
import com.docpal.warehousepda.domain.model.PutAwayScanDetail
import com.docpal.warehousepda.domain.model.ShelfOption
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
class PutAwayDetailViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakePutAwayDetailSource : PutAwayDetailSource {
        var detail: PutAwayDetail = detailWith("order-1")
        var throwOnCloseBox: LocalizedException? = null
        val getDetailCalls = ArrayList<String>()
        val createBoxCalls = ArrayList<Triple<String, String, String>>()
        val addAllCalls = ArrayList<Pair<String, String>>()
        val cancelBoxCalls = ArrayList<Pair<String, String>>()
        val closeBoxCalls = ArrayList<Pair<String, String>>()

        override suspend fun getPutAwayDetail(orderId: String): PutAwayDetail {
            getDetailCalls += orderId
            return detail.copy(header = detail.header.copy(id = orderId))
        }

        override suspend fun createBox(orderId: String, shelfCode: String, actorId: String) {
            createBoxCalls += Triple(orderId, shelfCode, actorId)
        }

        override suspend fun assignScanToBox(scanId: String, boxId: String, actorId: String) = Unit

        override suspend fun addAllToBox(boxId: String, actorId: String) {
            addAllCalls += boxId to actorId
        }

        override suspend fun removeScanFromBox(scanId: String, actorId: String) = Unit

        override suspend fun removeScannedPiece(scanId: String) = Unit

        override suspend fun closeBox(boxId: String, actorId: String) {
            throwOnCloseBox?.let { throw it }
            closeBoxCalls += boxId to actorId
        }

        override suspend fun cancelBox(boxId: String, actorId: String) {
            cancelBoxCalls += boxId to actorId
        }
    }

    private class FakeSessionSource(var userId: String?) : SessionSource {
        override fun currentUser(): User? =
            userId?.let { User(it, "operator", "Operator", "operator", 0L) }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun vm(
        source: FakePutAwayDetailSource,
        session: FakeSessionSource = FakeSessionSource("user-1"),
        orderId: String = "order-1",
    ) = PutAwayDetailViewModel(orderId, source, session, dispatcher)

    @Test fun `loads detail on init`() = runTest {
        val source = FakePutAwayDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        val detail = vm.uiState.value.detail!!
        assertEquals("order-1", detail.header.id)
        assertEquals("RO-001", detail.header.refNo)
        assertEquals(1, detail.lots.size)
        assertEquals(1, detail.boxes.size)
        assertFalse(vm.uiState.value.loading)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `create box delegates and reloads`() = runTest {
        val source = FakePutAwayDetailSource()
        val vm = vm(source)
        advanceUntilIdle()

        vm.openShelfDialog()
        assertTrue(vm.uiState.value.showShelfDialog)

        vm.createBox("A-01-01")
        advanceUntilIdle()
        assertEquals(listOf(Triple("order-1", "A-01-01", "user-1")), source.createBoxCalls)
        assertFalse(vm.uiState.value.showShelfDialog)
        // Once on init, once after the mutation.
        assertEquals(listOf("order-1", "order-1"), source.getDetailCalls)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `add all requires confirm then delegates`() = runTest {
        val source = FakePutAwayDetailSource()
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

    @Test fun `cancel box delegates and reloads`() = runTest {
        val source = FakePutAwayDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        vm.cancelBox("box-1")
        advanceUntilIdle()
        assertEquals(listOf("box-1" to "user-1"), source.cancelBoxCalls)
        assertEquals(listOf("order-1", "order-1"), source.getDetailCalls)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `repository error surfaces as errorKey`() = runTest {
        val source = FakePutAwayDetailSource().apply {
            throwOnCloseBox = LocalizedException("cannot_close_empty_shelf_box")
        }
        val vm = vm(source)
        advanceUntilIdle()
        vm.closeBox("box-1")
        advanceUntilIdle()
        assertEquals("cannot_close_empty_shelf_box", vm.uiState.value.errorKey)
        assertFalse(vm.uiState.value.actionInProgress)
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
                    dateCode = "2406", lotCode = "L1", coo = "MY", cow = "USA",
                    totalQty = 10, availableQty = 8, scannedQty = 2, boxedQty = 0,
                )
            ),
            scans = listOf(
                PutAwayScanDetail(
                    id = "scan-1", receivingInvoiceItemId = "item-1", qty = 2,
                    dateCode = "2406", lotCode = "L1", coo = "MY", cow = "USA",
                    shelfBoxId = null,
                )
            ),
            boxes = listOf(
                PutAwayBoxDetail(
                    id = "box-1", shelfCode = "A-01-01", zone = "A", status = "open",
                    createdAt = 0L, lineCount = 0, totalQty = 0, contents = emptyList(),
                )
            ),
            shelves = listOf(ShelfOption("A-01-01", "A")),
        )
    }
}
