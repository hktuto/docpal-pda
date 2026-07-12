package com.docpal.warehousepda.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.Allocator
import com.docpal.warehousepda.domain.PickingRepository
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PickingListRepositoryTest {

    private lateinit var db: AppDatabase

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `seeded orders list with finished last and total qty`() = runBlocking {
        val repo = PickingRepository(db, ReceivingRepository(db, Allocator(db)))
        val orders = repo.listOrders()
        assertTrue(orders.size >= 20) // seed has 23 picking orders
        val firstFinishedIndex = orders.indexOfFirst { it.status == "finished" }
        if (firstFinishedIndex >= 0) {
            assertTrue(orders.drop(firstFinishedIndex).all { it.status == "finished" })
        }
        val withItems = orders.first { it.totalQty > 0 }
        assertTrue(withItems.refNo.isNotEmpty())
    }
}
