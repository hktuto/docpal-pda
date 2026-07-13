package com.docpal.warehousepda.ui.goodsverify

import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.ShelfSummary
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
class GoodsVerifyShelfListViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeSource : GoodsVerifyShelfListSource {
        val shelves = mutableListOf<ShelfSummary>()
        var error: Exception? = null
        override suspend fun listShelves(): List<ShelfSummary> {
            error?.let { throw it }
            return shelves.toList()
        }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun `loads shelves`() = runTest {
        val source = FakeSource().apply {
            shelves += ShelfSummary("A1", "Zone A", 3)
            shelves += ShelfSummary("B2", null, 1)
        }
        val vm = GoodsVerifyShelfListViewModel(source, dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals(listOf("A1", "B2"), vm.uiState.value.shelves.map { it.code })
        assertEquals(false, vm.uiState.value.loading)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `empty list renders empty state`() = runTest {
        val vm = GoodsVerifyShelfListViewModel(FakeSource(), dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals(emptyList<ShelfSummary>(), vm.uiState.value.shelves)
        assertEquals(false, vm.uiState.value.loading)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `repository error surfaces as errorKey`() = runTest {
        val source = FakeSource().apply { error = LocalizedException("db_unavailable") }
        val vm = GoodsVerifyShelfListViewModel(source, dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals("db_unavailable", vm.uiState.value.errorKey)
        assertEquals(false, vm.uiState.value.loading)
        assertEquals(emptyList<ShelfSummary>(), vm.uiState.value.shelves)
    }
}
