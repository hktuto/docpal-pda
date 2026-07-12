package com.docpal.warehousepda.domain

import android.content.Context
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.ReceivingRepository
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Tests for [PickingRepository.cancelShippingBox] and [PickingRepository.finishPickingOrder]
 * (ports of web cancelShippingBox / finishPickingOrder), plus a regression guard that the
 * auto-finish path still logs {"auto": true} after the shared finishOrderInternal refactor.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CancelBoxAndFinishTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: PickingRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        repo = PickingRepository(db, ReceivingRepository(db, Allocator(db)))
        exec(
            "INSERT INTO parts (id, part_no, internal_code, description, default_coo) " +
                "VALUES ('$PART', 'TEST-PART-01', '', '', 'CN')"
        )
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `cancel empty open box deletes row and logs cancelled`() = runBlocking {
        insertPickingOrder(PO, "TEST-PO-01", "picking")
        insertBox(BOX1, PO, "open")

        repo.cancelShippingBox(BOX1, ACTOR)

        assertNull(offMainThread { db.pickingDao().boxById(BOX1) })
        assertEquals(
            1,
            intQuery(
                "SELECT COUNT(*) FROM transition_logs " +
                    "WHERE entity_type = 'shipping_box' AND entity_id = '$BOX1' " +
                    "AND from_state = 'open' AND to_state = 'cancelled'"
            ),
        )
        val metadata = stringQuery(
            "SELECT metadata FROM transition_logs " +
                "WHERE entity_type = 'shipping_box' AND entity_id = '$BOX1' AND to_state = 'cancelled'"
        )
        assertNotNull(metadata)
        assertTrue(metadata!!.contains(PO))
    }

    @Test
    fun `cancel box with packages throws box_is_not_empty`() = runBlocking {
        insertPickingOrder(PO, "TEST-PO-01", "picking")
        insertPickingItem(PI, PO, qty = 10, pickedQty = 5)
        insertBox(BOX1, PO, "open")
        insertPackage(PKG1, PI, PO, qty = 5, boxId = BOX1)

        expectCode("box_is_not_empty") { repo.cancelShippingBox(BOX1, ACTOR) }

        assertNotNull(offMainThread { db.pickingDao().boxById(BOX1) })
        assertEquals(
            0,
            intQuery(
                "SELECT COUNT(*) FROM transition_logs " +
                    "WHERE entity_type = 'shipping_box' AND entity_id = '$BOX1' AND to_state = 'cancelled'"
            ),
        )
    }

    @Test
    fun `cancel closed box throws box_is_not_open`() = runBlocking {
        insertPickingOrder(PO, "TEST-PO-01", "picking")
        insertBox(BOX1, PO, "sealed")

        expectCode("box_is_not_open") { repo.cancelShippingBox(BOX1, ACTOR) }

        assertNotNull(offMainThread { db.pickingDao().boxById(BOX1) })
    }

    @Test
    fun `finish creates measuring task and assigns boxes`() = runBlocking {
        insertPickingOrder(PO, "TEST-PO-01", "picking")
        insertPickingItem(PI, PO, qty = 10, pickedQty = 10)
        insertBox(BOX1, PO, "open")
        insertPackage(PKG1, PI, PO, qty = 10, boxId = BOX1)

        repo.finishPickingOrder(PO, ACTOR)

        assertEquals("finished", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO'"))
        assertEquals(1, intQuery("SELECT COUNT(*) FROM measuring_tasks WHERE picking_order_id = '$PO'"))
        val task = offMainThread { db.pickingDao().measuringTaskOfOrder(PO) }
        assertNotNull(task)
        assertEquals("pending", task!!.status)
        assertEquals(task.id, stringQuery("SELECT measuring_task_id FROM shipping_boxes WHERE id = '$BOX1'"))
        // Manual finish logs the transition with NULL metadata (auto uses {"auto": true}).
        assertEquals(
            1,
            intQuery(
                "SELECT COUNT(*) FROM transition_logs " +
                    "WHERE entity_type = 'picking_order' AND entity_id = '$PO' " +
                    "AND from_state = 'picking' AND to_state = 'finished' AND metadata IS NULL"
            ),
        )
    }

    @Test
    fun `finish with unboxed remainder throws not_all_items_fully_boxed`() = runBlocking {
        insertPickingOrder(PO, "TEST-PO-01", "picking")
        insertPickingItem(PI, PO, qty = 10, pickedQty = 5)

        expectCode("not_all_items_fully_boxed") { repo.finishPickingOrder(PO, ACTOR) }

        assertEquals("picking", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO'"))
        assertEquals(0, intQuery("SELECT COUNT(*) FROM measuring_tasks WHERE picking_order_id = '$PO'"))
    }

    @Test
    fun `finish issue order throws picking_order_has_open_issue`() = runBlocking {
        insertPickingOrder(PO, "TEST-PO-01", "issue")
        insertPickingItem(PI, PO, qty = 10, pickedQty = 10)

        expectCode("picking_order_has_open_issue") { repo.finishPickingOrder(PO, ACTOR) }

        assertEquals("issue", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO'"))
    }

    @Test
    fun `finish guard codes for missing order, finished order and empty order`() = runBlocking {
        expectCode("picking_order_not_found") { repo.finishPickingOrder("no-such-order", ACTOR) }

        insertPickingOrder(PO, "TEST-PO-01", "finished")
        expectCode("order_already_finished") { repo.finishPickingOrder(PO, ACTOR) }

        insertPickingOrder(PO2, "TEST-PO-02", "picking")
        expectCode("no_items_to_pick") { repo.finishPickingOrder(PO2, ACTOR) }

        expectCode("box_not_found") { repo.cancelShippingBox("no-such-box", ACTOR) }
    }

    @Test
    fun `auto finish still logs auto metadata`() = runBlocking {
        insertPickingOrder(PO, "TEST-PO-01", "picking")
        insertPickingItem(PI, PO, qty = 10, pickedQty = 0)
        insertBox(BOX1, PO, "open")
        insertPackage(PKG1, PI, PO, qty = 10, boxId = null)

        repo.addPackageToBox(PKG1, BOX1, ACTOR)

        assertEquals("finished", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO'"))
        val metadata = stringQuery(
            "SELECT metadata FROM transition_logs " +
                "WHERE entity_type = 'picking_order' AND entity_id = '$PO' AND to_state = 'finished'"
        )
        assertNotNull(metadata)
        assertTrue(metadata!!.contains("auto"))
    }

    private fun insertPickingOrder(id: String, refNo: String, status: String) {
        exec(
            "INSERT INTO picking_orders (id, ref_no, supplier_id, delivery_date, po_no, required_date_code_notice, ship_to, destination_country, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark, issue_reported_at, issue_reported_by, status, created_at, updated_at) " +
                "VALUES ('$id', '$refNo', NULL, 1783872000000, NULL, NULL, 'GZ', 'China', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '$status', 1783779245783, 1783779245783)"
        )
    }

    private fun insertPickingItem(id: String, orderId: String, qty: Int, pickedQty: Int) {
        exec(
            "INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, allocated_qty, required_date_code, source_shelf_code) " +
                "VALUES ('$id', '$orderId', '$PART', $qty, $pickedQty, 0, NULL, NULL)"
        )
    }

    private fun insertPackage(id: String, itemId: String, orderId: String, qty: Int, boxId: String?) {
        exec(
            "INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, date_code, lot_code, coo, cow, verified, created_at) " +
                "VALUES ('$id', '$itemId', '$orderId', 'inventory_lot', 'no-such-lot', $qty, ${boxId?.let { "'$it'" } ?: "NULL"}, NULL, NULL, NULL, NULL, 0, 1783779245783)"
        )
    }

    private fun insertBox(id: String, orderId: String, status: String) {
        exec(
            "INSERT INTO shipping_boxes (id, picking_order_id, measuring_task_id, status, gross_weight, net_weight, destination_country, box_size, created_at) " +
                "VALUES ('$id', '$orderId', NULL, '$status', NULL, NULL, NULL, NULL, 1783779245783)"
        )
    }

    private fun exec(sql: String) = offMainThread {
        db.openHelper.writableDatabase.execSQL(sql)
    }

    private fun intQuery(sql: String): Int = offMainThread {
        db.query(SimpleSQLiteQuery(sql)).use { c ->
            c.moveToFirst()
            c.getInt(0)
        }
    }

    private fun stringQuery(sql: String): String? = offMainThread {
        db.query(SimpleSQLiteQuery(sql)).use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
        }
    }

    private fun expectCode(code: String, block: suspend () -> Unit) = runBlocking {
        try {
            block()
            fail("expected LocalizedException '$code'")
        } catch (e: LocalizedException) {
            assertEquals(code, e.code)
        }
    }

    companion object {
        private const val ACTOR = "user-1"

        private const val PART = "bbbb0000-0000-0000-0000-000000000001"
        private const val PO = "eeee0000-0000-0000-0000-000000000001"
        private const val PO2 = "eeee0000-0000-0000-0000-000000000002"
        private const val PI = "ffff0000-0000-0000-0000-000000000001"
        private const val PKG1 = "33330000-0000-0000-0000-000000000001"
        private const val BOX1 = "44440000-0000-0000-0000-000000000001"
    }
}
