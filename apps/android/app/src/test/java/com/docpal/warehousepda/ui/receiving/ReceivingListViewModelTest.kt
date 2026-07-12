package com.docpal.warehousepda.ui.receiving

import com.docpal.warehousepda.domain.model.ReceivingOrderSummary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ReceivingListViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeSource : ReceivingListSource {
        val orders = mutableListOf<ReceivingOrderSummary>()
        val requestedFilters = ArrayList<String>()
        override suspend fun listOrders(filter: String): List<ReceivingOrderSummary> {
            requestedFilters.add(filter)
            return orders.filter { filter == "all" || it.status == filter }
        }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun `loads in_hand by default`() = runTest {
        val source = FakeSource()
        val vm = ReceivingListViewModel(source, dispatcher)
        // The screen triggers the first load via OnResumeEffect (initial ON_RESUME).
        vm.reload()
        advanceUntilIdle()
        assertEquals(listOf("in_hand"), source.requestedFilters)
    }

    @Test fun `filter change reloads`() = runTest {
        val source = FakeSource()
        val vm = ReceivingListViewModel(source, dispatcher)
        vm.reload()
        advanceUntilIdle()
        vm.setFilter("pending")
        advanceUntilIdle()
        assertEquals(listOf("in_hand", "pending"), source.requestedFilters)
    }

    @Test fun `search filters client side by ref and supplier`() = runTest {
        val source = FakeSource().apply {
            orders += ReceivingOrderSummary("1", "RO-001", "in_hand", null, "KOA", 2, 0)
            orders += ReceivingOrderSummary("2", "RO-002", "in_hand", null, "Diotec", 1, 0)
        }
        val vm = ReceivingListViewModel(source, dispatcher)
        vm.reload()
        advanceUntilIdle()
        vm.setSearch("koa")
        assertEquals(listOf("RO-001"), vm.uiState.value.visibleOrders.map { it.refNo })
        vm.setSearch("002")
        assertEquals(listOf("RO-002"), vm.uiState.value.visibleOrders.map { it.refNo })
    }

    @Test fun `reload re-queries with current filter`() = runTest {
        val source = FakeSource()
        val vm = ReceivingListViewModel(source, dispatcher)
        vm.reload()
        advanceUntilIdle()
        vm.setFilter("all"); advanceUntilIdle()
        vm.reload(); advanceUntilIdle()
        assertEquals(listOf("in_hand", "all", "all"), source.requestedFilters)
    }

    @Test fun `load exposes orders in ui state`() = runTest {
        val source = FakeSource().apply {
            orders += ReceivingOrderSummary("1", "RO-001", "in_hand", null, "KOA", 2, 0)
            orders += ReceivingOrderSummary("2", "RO-002", "in_hand", null, "Diotec", 1, 0)
        }
        val vm = ReceivingListViewModel(source, dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals(listOf("RO-001", "RO-002"), vm.uiState.value.orders.map { it.refNo })
        assertEquals(false, vm.uiState.value.loading)
    }
}
