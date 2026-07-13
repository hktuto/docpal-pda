package com.docpal.warehousepda.ui.goodsverify

import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.VerifyBoxSummary
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
class GoodsVerifyBoxListViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeSource : GoodsVerifyBoxListSource {
        val boxes = mutableListOf<VerifyBoxSummary>()
        var error: Exception? = null
        var lastShelfCode: String? = null
        override suspend fun listBoxes(shelfCode: String): List<VerifyBoxSummary> {
            lastShelfCode = shelfCode
            error?.let { throw it }
            return boxes.toList()
        }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun `loads boxes for shelf`() = runTest {
        val source = FakeSource().apply {
            boxes += VerifyBoxSummary("BOX-1", "open", itemCount = 3, verifiedCount = 1, lastCheckAt = null, checkedToday = false)
            boxes += VerifyBoxSummary("BOX-2", "verified", itemCount = 2, verifiedCount = 2, lastCheckAt = 1_700_000_000_000L, checkedToday = true)
        }
        val vm = GoodsVerifyBoxListViewModel("A1", source, dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals(listOf("BOX-1", "BOX-2"), vm.uiState.value.boxes.map { it.id })
        assertEquals(false, vm.uiState.value.loading)
        assertNull(vm.uiState.value.errorKey)
        assertEquals("A1", source.lastShelfCode)
    }

    @Test fun `empty shelf renders empty state`() = runTest {
        val vm = GoodsVerifyBoxListViewModel("A1", FakeSource(), dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals(emptyList<VerifyBoxSummary>(), vm.uiState.value.boxes)
        assertEquals(false, vm.uiState.value.loading)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `repository error surfaces as errorKey`() = runTest {
        val source = FakeSource().apply { error = LocalizedException("db_unavailable") }
        val vm = GoodsVerifyBoxListViewModel("A1", source, dispatcher)
        vm.reload()
        advanceUntilIdle()
        assertEquals("db_unavailable", vm.uiState.value.errorKey)
        assertEquals(false, vm.uiState.value.loading)
        assertEquals(emptyList<VerifyBoxSummary>(), vm.uiState.value.boxes)
    }
}
