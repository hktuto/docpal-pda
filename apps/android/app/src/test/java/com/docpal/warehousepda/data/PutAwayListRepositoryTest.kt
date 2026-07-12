package com.docpal.warehousepda.data

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.PutAwayRepository
import com.docpal.warehousepda.domain.insertAllocation
import com.docpal.warehousepda.domain.insertPart
import com.docpal.warehousepda.domain.insertPickingItem
import com.docpal.warehousepda.domain.insertPickingOrder
import com.docpal.warehousepda.domain.insertPutAwayScan
import com.docpal.warehousepda.domain.insertReceivingInvoice
import com.docpal.warehousepda.domain.insertReceivingInvoiceItem
import com.docpal.warehousepda.domain.insertReceivingOrder
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PutAwayListRepositoryTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: PutAwayRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        // Seed-agnostic: wipe the imported seed.sql rows so every test assembles
        // its own synthetic fixture with deterministic ids.
        offMainThread { db.clearAllTables() }
        repo = PutAwayRepository(db)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `in hand order with availability is a candidate`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
        }

        val candidates = repo.listCandidates()

        assertEquals(1, candidates.size)
        val candidate = candidates.single()
        assertEquals("pa-order-1", candidate.orderId)
        assertEquals("PA-001", candidate.refNo)
        assertEquals("in_hand", candidate.status)
        assertEquals(10, candidate.availableQty)
    }

    @Test
    fun `order fully put away is not a candidate`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10, putAwayQty = 10)
        }

        assertTrue(repo.listCandidates().isEmpty())
    }

    @Test
    fun `order with only unboxed scans is still a candidate`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        // Coarse allocation against the receiving order consumes all 10 of the part.
        insertPickingOrder(db, "pa-pick-1", "PICK-1", "pending")
        insertPickingItem(db, "pa-pi-1", "pa-pick-1", "pa-part-1", qty = 10)
        insertAllocation(db, "pa-alloc-1", itemId = "pa-pi-1", receivingOrderId = "pa-order-1", qty = 10)
        fixture { wdb ->
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
            // Fully allocated + fully scanned-but-unboxed: availability 0, must still appear.
            insertPutAwayScan(wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 10)
        }

        val candidates = repo.listCandidates()

        assertEquals(1, candidates.size)
        val candidate = candidates.single()
        assertEquals("pa-order-1", candidate.orderId)
        assertEquals(0, candidate.availableQty)
    }

    @Test
    fun `pending and clear orders are excluded`() = runBlocking {
        insertReceivingOrder(db, "pa-order-pending", "PA-PENDING", "pending")
        insertReceivingOrder(db, "pa-order-clear", "PA-CLEAR", "clear")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertReceivingInvoice(wdb, "pa-inv-pending", "pa-order-pending")
            insertReceivingInvoiceItem(wdb, "pa-item-pending", "pa-inv-pending", "pa-part-1", qty = 10)
            insertReceivingInvoice(wdb, "pa-inv-clear", "pa-order-clear")
            insertReceivingInvoiceItem(wdb, "pa-item-clear", "pa-inv-clear", "pa-part-1", qty = 10)
        }

        assertTrue(repo.listCandidates().isEmpty())
    }

    /** Batches raw fixture inserts in one off-main-thread block (Room forbids main-thread writes). */
    private fun fixture(block: (SupportSQLiteDatabase) -> Unit) = offMainThread {
        block(db.openHelper.writableDatabase)
    }
}
