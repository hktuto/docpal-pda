package com.docpal.warehousepda.ui.picking

import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PickingIssueInput
import com.docpal.warehousepda.domain.model.PickingOrderSummary
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
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PickingListViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeSource : PickingListSource {
        val orders = mutableListOf<PickingOrderSummary>()
        var listCalls = 0
        var reportResult: Pair<Int, Int> = 1 to 0
        var reportError: Exception? = null
        val reportedEntries = ArrayList<List<Pair<String, String?>>>()

        override suspend fun listOrders(): List<PickingOrderSummary> {
            listCalls++
            return orders.toList()
        }

        override suspend fun reportIssues(
            entries: List<Pair<String, String?>>,
            input: PickingIssueInput,
            actorId: String,
        ): Pair<Int, Int> {
            reportedEntries += entries
            reportError?.let { throw it }
            return reportResult
        }
    }

    private class FakeSession(private val user: User?) : SessionSource {
        override fun currentUser(): User? = user
    }

    private val session = FakeSession(User("u1", "operator", "Operator", "operator", 0L))

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun `loads orders and searches client side`() = runTest {
        val source = FakeSource().apply {
            orders += PickingOrderSummary("1", "RO-1", "pending", null, "KOA", "HK", 10)
            orders += PickingOrderSummary("2", "RO-2", "picking", null, "Diotec", "HK", 5)
        }
        val vm = PickingListViewModel(source, session, dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals(listOf("RO-1", "RO-2"), vm.uiState.value.visibleOrders.map { it.refNo })
        vm.setSearch("koa")
        assertEquals(listOf("RO-1"), vm.uiState.value.visibleOrders.map { it.refNo })
    }

    @Test fun `selection ignores non selectable orders`() = runTest {
        val source = FakeSource().apply {
            orders += PickingOrderSummary("1", "RO-1", "pending", null, null, null, 1)
            orders += PickingOrderSummary("2", "RO-2", "picking", null, null, null, 1)
            orders += PickingOrderSummary("3", "RO-3", "finished", null, null, null, 1)
            orders += PickingOrderSummary("4", "RO-4", "issue", null, null, null, 1)
        }
        val vm = PickingListViewModel(source, session, dispatcher)
        vm.reload()
        advanceUntilIdle()
        listOf("1", "2", "3", "4").forEach(vm::toggleSelection)
        assertEquals(setOf("1", "2"), vm.uiState.value.selectedIds)
    }

    @Test fun `selection survives reload`() = runTest {
        val source = FakeSource().apply {
            orders += PickingOrderSummary("1", "RO-1", "pending", null, "KOA", null, 10)
            orders += PickingOrderSummary("2", "RO-2", "picking", null, "Diotec", null, 5)
        }
        val vm = PickingListViewModel(source, session, dispatcher)
        vm.reload()
        advanceUntilIdle()
        vm.toggleSelection("1")
        vm.reload()
        advanceUntilIdle()
        assertEquals(setOf("1"), vm.uiState.value.selectedIds)
        // The reload actually re-queried the source.
        assertEquals(2, source.listCalls)
        assertEquals(listOf("RO-1", "RO-2"), vm.uiState.value.orders.map { it.refNo })
    }

    @Test fun `report success clears selection reloads and toasts`() = runTest {
        val source = FakeSource().apply {
            orders += PickingOrderSummary("1", "RO-1", "pending", null, "KOA", null, 10)
        }
        val vm = PickingListViewModel(source, session, dispatcher)
        vm.reload()
        advanceUntilIdle()
        vm.toggleSelection("1")
        vm.reportIssues("other", null, null, "bad labels", emptyMap())
        advanceUntilIdle()
        assertEquals(emptySet<String>(), vm.uiState.value.selectedIds)
        // Initial load + post-report reload.
        assertEquals(2, source.listCalls)
        assertEquals("issue_reported", vm.uiState.value.toastKey)
        assertEquals(listOf(1, 0), vm.uiState.value.toastArgs)
        assertFalse(vm.uiState.value.reporting)
    }

    @Test fun `report maps remarks to entries`() = runTest {
        val source = FakeSource().apply {
            orders += PickingOrderSummary("1", "RO-1", "pending", null, "KOA", null, 10)
            orders += PickingOrderSummary("2", "RO-2", "picking", null, "Diotec", null, 5)
        }
        val vm = PickingListViewModel(source, session, dispatcher)
        vm.reload()
        advanceUntilIdle()
        vm.toggleSelection("1")
        vm.toggleSelection("2")
        vm.reportIssues(
            "other", null, null, "note",
            remarks = mapOf("1" to "  keep this  ", "2" to "   "),
        )
        advanceUntilIdle()
        // One entry per selected order (in list order): remark trimmed, blank -> null.
        assertEquals(
            listOf(listOf("1" to "keep this", "2" to null)),
            source.reportedEntries,
        )
    }

    @Test fun `report validation error surfaces as errorKey`() = runTest {
        val source = FakeSource().apply {
            orders += PickingOrderSummary("1", "RO-1", "pending", null, "KOA", null, 10)
            reportError = LocalizedException("no_reportable_orders_selected")
        }
        val vm = PickingListViewModel(source, session, dispatcher)
        vm.reload()
        advanceUntilIdle()
        vm.toggleSelection("1")
        vm.reportIssues("other", null, null, "note", emptyMap())
        advanceUntilIdle()
        assertEquals("no_reportable_orders_selected", vm.uiState.value.errorKey)
        assertFalse(vm.uiState.value.reporting)
        // Failed report keeps the selection (web parity: modal stays open).
        assertEquals(setOf("1"), vm.uiState.value.selectedIds)
    }
}
