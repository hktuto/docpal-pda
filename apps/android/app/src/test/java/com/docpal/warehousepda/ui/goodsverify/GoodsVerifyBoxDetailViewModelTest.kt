package com.docpal.warehousepda.ui.goodsverify

import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.User
import com.docpal.warehousepda.domain.model.VerifyBoxDetail
import com.docpal.warehousepda.domain.model.VerifyBoxItem
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
class GoodsVerifyBoxDetailViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private class FakeGoodsVerifyBoxDetailSource : GoodsVerifyBoxDetailSource {
        var detail: VerifyBoxDetail? = detailWith("box-1")
        var throwOnMarkVerified: LocalizedException? = null
        val getDetailCalls = ArrayList<String>()
        val verifyItemCalls = ArrayList<Pair<String, String>>()
        val markVerifiedCalls = ArrayList<Pair<String, String>>()

        override suspend fun getBoxDetail(boxId: String): VerifyBoxDetail? {
            getDetailCalls += boxId
            return detail?.copy(id = boxId)
        }

        override suspend fun verifyItem(boxId: String, partId: String) {
            verifyItemCalls += boxId to partId
        }

        override suspend fun markBoxVerified(boxId: String, actorId: String) {
            throwOnMarkVerified?.let { throw it }
            markVerifiedCalls += boxId to actorId
        }
    }

    private class FakeSessionSource(var userId: String?) : SessionSource {
        override fun currentUser(): User? =
            userId?.let { User(it, "operator", "Operator", "operator", 0L) }
    }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun vm(
        source: FakeGoodsVerifyBoxDetailSource,
        session: FakeSessionSource = FakeSessionSource("user-1"),
        boxId: String = "box-1",
    ) = GoodsVerifyBoxDetailViewModel(boxId, source, session, dispatcher)

    @Test fun `loads detail on init`() = runTest {
        val source = FakeGoodsVerifyBoxDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        val detail = vm.uiState.value.detail!!
        assertEquals("box-1", detail.id)
        assertEquals(2, detail.items.size)
        assertFalse(vm.uiState.value.loading)
        assertNull(vm.uiState.value.errorKey)
    }

    @Test fun `mark verified delegates and reloads`() = runTest {
        val source = FakeGoodsVerifyBoxDetailSource().apply {
            detail = detailWith("box-1", allVerified = true)
        }
        val vm = vm(source)
        advanceUntilIdle()
        vm.markVerified()
        advanceUntilIdle()
        assertEquals(listOf("box-1" to "user-1"), source.markVerifiedCalls)
        // Once on init, once after the mutation.
        assertEquals(listOf("box-1", "box-1"), source.getDetailCalls)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    @Test fun `canMarkVerified false until all items verified`() = runTest {
        val source = FakeGoodsVerifyBoxDetailSource()
        val vm = vm(source)
        advanceUntilIdle()
        // Default fixture: one unverified item.
        assertFalse(vm.uiState.value.canMarkVerified)

        source.detail = detailWith("box-1", allVerified = true)
        vm.reload()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.canMarkVerified)

        source.detail = detailWith("box-1", allVerified = true, status = "verified")
        vm.reload()
        advanceUntilIdle()
        assertFalse(vm.uiState.value.canMarkVerified)
    }

    @Test fun `repository error surfaces as errorKey`() = runTest {
        val source = FakeGoodsVerifyBoxDetailSource().apply {
            throwOnMarkVerified = LocalizedException("not_all_shelf_box_items_verified")
        }
        val vm = vm(source)
        advanceUntilIdle()
        vm.markVerified()
        advanceUntilIdle()
        assertEquals("not_all_shelf_box_items_verified", vm.uiState.value.errorKey)
        assertFalse(vm.uiState.value.actionInProgress)
    }

    private companion object {
        fun detailWith(id: String, allVerified: Boolean = false, status: String = "open") =
            VerifyBoxDetail(
                id = id, status = status, shelfCode = "A-01-01", shelfZone = "A",
                items = listOf(
                    VerifyBoxItem("part-1", "IC-1", "Resistor", 10, true, 1000L),
                    VerifyBoxItem("part-2", "IC-2", null, 5, allVerified, if (allVerified) 2000L else null),
                ),
            )
    }
}
