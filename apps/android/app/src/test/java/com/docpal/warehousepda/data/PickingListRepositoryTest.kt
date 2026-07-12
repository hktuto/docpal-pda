package com.docpal.warehousepda.data

import android.content.Context
import androidx.sqlite.db.SimpleSQLiteQuery
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
        // A pending order with a delivery_date earlier than the seed's but NOT the
        // finished fixture's: pins the delivery_date tiebreak inside the non-finished group.
        exec(
            "INSERT INTO picking_orders (id, ref_no, supplier_id, delivery_date, po_no, required_date_code_notice, ship_to, destination_country, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark, issue_reported_at, issue_reported_by, status, created_at, updated_at) " +
                "VALUES ('$EARLY_PENDING_ORDER', 'TEST-PO-EARLY', NULL, 1783536000000, NULL, NULL, 'GZ', 'China', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pending', 1783779245783, 1783779245783)"
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

        // Business-key lookup (no seed UUIDs): a seeded order's totalQty must equal
        // the sum of its picking_items qtys.
        val seededRef = "GZ-26070045"
        val seededId = stringQuery(
            "SELECT id FROM picking_orders WHERE ref_no = '$seededRef'"
        )
        val expectedTotal = intQuery(
            "SELECT COALESCE(SUM(qty), 0) FROM picking_items WHERE picking_order_id = '$seededId'"
        )
        assertEquals(expectedTotal, orders.first { it.refNo == seededRef }.totalQty)
    }

    @Test
    fun `delivery date tiebreak orders non-finished group earliest first`() = runBlocking {
        val repo = PickingRepository(db, ReceivingRepository(db, Allocator(db)))
        val orders = repo.listOrders()
        // The pending fixture has the earliest non-null delivery_date in the
        // non-finished group, so the date tiebreak must put it first.
        assertEquals(EARLY_PENDING_ORDER, orders.first().id)
    }

    private fun exec(sql: String) = offMainThread {
        db.openHelper.writableDatabase.execSQL(sql)
    }

    private fun stringQuery(sql: String): String = offMainThread {
        db.openHelper.readableDatabase.query(SimpleSQLiteQuery(sql)).use { c ->
            c.moveToFirst()
            c.getString(0)
        }
    }

    private fun intQuery(sql: String): Int = offMainThread {
        db.openHelper.readableDatabase.query(SimpleSQLiteQuery(sql)).use { c ->
            c.moveToFirst()
            c.getInt(0)
        }
    }

    companion object {
        private const val FINISHED_ORDER = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        private const val EARLY_PENDING_ORDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    }
}
