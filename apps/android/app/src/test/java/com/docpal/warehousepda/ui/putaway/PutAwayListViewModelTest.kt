package com.docpal.warehousepda.ui.putaway

import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PutAwayCandidate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PutAwayListViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeSource : PutAwayListSource {
        val orders = mutableListOf<PutAwayCandidate>()
        var error: Exception? = null
        override suspend fun listCandidates(): List<PutAwayCandidate> {
            error?.let { throw it }
            return orders.toList()
        }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun `loads candidates`() = runTest {
        val source = FakeSource().apply {
            orders += PutAwayCandidate("1", "RO-001", "in_hand", "KOA", 10)
            orders += PutAwayCandidate("2", "RO-002", "in_hand", null, 4)
        }
        val vm = PutAwayListViewModel(source, dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals(listOf("RO-001", "RO-002"), vm.uiState.value.orders.map { it.refNo })
        assertEquals(false, vm.uiState.value.loading)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `empty list renders empty state`() = runTest {
        val vm = PutAwayListViewModel(FakeSource(), dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals(emptyList<PutAwayCandidate>(), vm.uiState.value.orders)
        assertEquals(false, vm.uiState.value.loading)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `repository error surfaces as errorKey`() = runTest {
        val source = FakeSource().apply { error = LocalizedException("db_unavailable") }
        val vm = PutAwayListViewModel(source, dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals("db_unavailable", vm.uiState.value.errorKey)
        assertEquals(false, vm.uiState.value.loading)
        assertEquals(emptyList<PutAwayCandidate>(), vm.uiState.value.orders)
    }
}
