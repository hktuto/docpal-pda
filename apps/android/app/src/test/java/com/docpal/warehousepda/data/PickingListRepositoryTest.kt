package com.docpal.warehousepda.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.Allocator
import com.docpal.warehousepda.domain.PickingRepository
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
class PickingListRepositoryTest {

    private lateinit var db: AppDatabase

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        // Seed has no finished orders; add one with a delivery_date EARLIER than the
        // seeded orders (1783872000000) so the CASE ordering — not the date tiebreak —
        // is what sinks it to the end of the list.
        exec(
            "INSERT INTO picking_orders (id, ref_no, supplier_id, delivery_date, po_no, required_date_code_notice, ship_to, destination_country, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark, issue_reported_at, issue_reported_by, status, created_at, updated_at) " +
                "VALUES ('$FINISHED_ORDER', 'TEST-PO-FINISHED', NULL, 1783449600000, NULL, NULL, 'GZ', 'China', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'finished', 1783779245783, 1783779245783)"
        )
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `seeded orders list with finished last and total qty`() = runBlocking {
        val repo = PickingRepository(db, ReceivingRepository(db, Allocator(db)))
        val orders = repo.listOrders()
        assertTrue(orders.size >= 20) // seed has 23 picking orders
        // The finished fixture has the earliest delivery_date; the CASE in ORDER BY
        // must sink it to the last row regardless.
        assertEquals(FINISHED_ORDER, orders.last().id)
        val withItems = orders.first { it.totalQty > 0 }
        assertTrue(withItems.refNo.isNotEmpty())
    }

    private fun exec(sql: String) = offMainThread {
        db.openHelper.writableDatabase.execSQL(sql)
    }

    companion object {
        private const val FINISHED_ORDER = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    }
}
