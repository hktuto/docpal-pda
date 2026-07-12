package com.docpal.warehousepda.domain

import android.content.Context
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.ReceivingRepository
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.model.PickingIssueInput
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Tests for [PickingRepository.reportPickingOrderIssues] (web reportPickingOrderIssues,
 * apps/web/db/picking.ts) against an isolated synthetic fixture.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReportPickingIssuesTest {

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

    private fun insertPickingOrder(id: String, refNo: String, status: String, totalQty: Int) {
        exec(
            "INSERT INTO picking_orders (id, ref_no, supplier_id, delivery_date, po_no, required_date_code_notice, ship_to, destination_country, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark, issue_reported_at, issue_reported_by, status, created_at, updated_at) " +
                "VALUES ('$id', '$refNo', NULL, 1783872000000, NULL, NULL, 'GZ', 'China', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '$status', 1783779245783, 1783779245783)"
        )
        exec(
            "INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, allocated_qty, required_date_code, source_shelf_code) " +
                "VALUES ('item-$id', '$id', '$PART', $totalQty, 0, 0, NULL, NULL)"
        )
    }

    @Test
    fun `reports issue on pending order with all fields and log`() = runBlocking {
        insertPickingOrder(PO1, "TEST-PO-01", "pending", totalQty = 10)
        insertPickingOrder(PO2, "TEST-PO-02", "pending", totalQty = 8)

        val (reported, skipped) = repo.reportPickingOrderIssues(
            entries = listOf(PO1 to "short by 5", PO2 to null),
            input = PickingIssueInput(reason = "insufficient_stock", qty = 3, packSize = null, note = "truck short"),
            actorId = "user-1",
        )
        assertEquals(2 to 0, reported to skipped)

        // po-1 row: all issue fields set.
        assertEquals("issue", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("insufficient_stock", stringQuery("SELECT issue_reason FROM picking_orders WHERE id = '$PO1'"))
        assertEquals(3, intQuery("SELECT issue_qty FROM picking_orders WHERE id = '$PO1'"))
        assertNull(stringQuery("SELECT issue_pack_size FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("truck short", stringQuery("SELECT issue_note FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("short by 5", stringQuery("SELECT issue_remark FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("user-1", stringQuery("SELECT issue_reported_by FROM picking_orders WHERE id = '$PO1'"))
        assertNotNull(stringQuery("SELECT issue_reported_at FROM picking_orders WHERE id = '$PO1'"))

        // po-2 row: same reason fields, no remark.
        assertEquals("issue", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO2'"))
        assertEquals(3, intQuery("SELECT issue_qty FROM picking_orders WHERE id = '$PO2'"))
        assertNull(stringQuery("SELECT issue_remark FROM picking_orders WHERE id = '$PO2'"))

        // One transition log per order: pending -> issue.
        assertEquals(
            1,
            intQuery(
                "SELECT COUNT(*) FROM transition_logs " +
                    "WHERE entity_type = 'picking_order' AND entity_id = '$PO1' AND from_state = 'pending' AND to_state = 'issue' AND actor_id = 'user-1'"
            ),
        )
        assertEquals(
            1,
            intQuery(
                "SELECT COUNT(*) FROM transition_logs " +
                    "WHERE entity_type = 'picking_order' AND entity_id = '$PO2' AND from_state = 'pending' AND to_state = 'issue'"
            ),
        )

        // Metadata JSON carries the web's key names; absent values stay absent.
        val meta1 = JSONObject(
            stringQuery("SELECT metadata FROM transition_logs WHERE entity_id = '$PO1' AND to_state = 'issue'")!!
        )
        assertEquals("insufficient_stock", meta1.getString("reason"))
        assertEquals(3, meta1.getInt("qty"))
        assertEquals("truck short", meta1.getString("note"))
        assertEquals("short by 5", meta1.getString("remark"))
        assertFalse(meta1.has("packSize"))

        val meta2 = JSONObject(
            stringQuery("SELECT metadata FROM transition_logs WHERE entity_id = '$PO2' AND to_state = 'issue'")!!
        )
        assertEquals("insufficient_stock", meta2.getString("reason"))
        assertFalse(meta2.has("remark"))
    }

    @Test
    fun `merge requires at least two orders`() = runBlocking {
        insertPickingOrder(PO1, "TEST-PO-01", "pending", totalQty = 10)
        expectCode("select_at_least_two_orders_to_merge") {
            repo.reportPickingOrderIssues(
                listOf(PO1 to null),
                PickingIssueInput("merge", null, null, null),
                "user-1",
            )
        }
    }

    @Test
    fun `finished and issue orders are skipped`() = runBlocking {
        insertPickingOrder(PO1, "TEST-PO-01", "finished", totalQty = 10)
        insertPickingOrder(PO2, "TEST-PO-02", "issue", totalQty = 8)
        insertPickingOrder(PO3, "TEST-PO-03", "pending", totalQty = 5)

        val (reported, skipped) = repo.reportPickingOrderIssues(
            entries = listOf(PO1 to null, PO2 to null, PO3 to "late truck"),
            input = PickingIssueInput("other", null, null, null),
            actorId = "user-1",
        )
        assertEquals(1 to 2, reported to skipped)

        // Finished / issue rows untouched.
        assertEquals("finished", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO1'"))
        assertNull(stringQuery("SELECT issue_reason FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("issue", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO2'"))
        assertNull(stringQuery("SELECT issue_reason FROM picking_orders WHERE id = '$PO2'"))
        // Pending row reported.
        assertEquals("other", stringQuery("SELECT issue_reason FROM picking_orders WHERE id = '$PO3'"))
        assertEquals("late truck", stringQuery("SELECT issue_remark FROM picking_orders WHERE id = '$PO3'"))
        assertNull(stringQuery("SELECT issue_qty FROM picking_orders WHERE id = '$PO3'"))
        assertNull(stringQuery("SELECT issue_pack_size FROM picking_orders WHERE id = '$PO3'"))
        assertEquals(
            1,
            intQuery("SELECT COUNT(*) FROM transition_logs WHERE entity_id = '$PO3' AND to_state = 'issue'"),
        )
    }

    @Test
    fun `insufficient stock qty must be below order total`() = runBlocking {
        insertPickingOrder(PO1, "TEST-PO-01", "pending", totalQty = 10)
        expectCode("actual_qty_must_be_less_than_requested") {
            repo.reportPickingOrderIssues(
                listOf(PO1 to null),
                PickingIssueInput(reason = "insufficient_stock", qty = 10, packSize = null, note = null),
                "user-1",
            )
        }
        // Nothing written.
        assertEquals("pending", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO1'"))
    }

    @Test
    fun `no reportable orders throws`() = runBlocking {
        insertPickingOrder(PO1, "TEST-PO-01", "finished", totalQty = 10)
        insertPickingOrder(PO2, "TEST-PO-02", "finished", totalQty = 8)
        expectCode("no_reportable_orders_selected") {
            repo.reportPickingOrderIssues(
                listOf(PO1 to null, PO2 to null),
                PickingIssueInput("other", null, null, null),
                "user-1",
            )
        }
    }

    @Test
    fun `input validation errors match web keys`() = runBlocking {
        insertPickingOrder(PO1, "TEST-PO-01", "pending", totalQty = 10)
        expectCode("no_orders_selected") {
            repo.reportPickingOrderIssues(
                emptyList(),
                PickingIssueInput("other", null, null, null),
                "user-1",
            )
        }
        expectCode("actual_quantity_required") {
            repo.reportPickingOrderIssues(
                listOf(PO1 to null),
                PickingIssueInput(reason = "insufficient_stock", qty = null, packSize = null, note = null),
                "user-1",
            )
        }
        expectCode("pack_size_required") {
            repo.reportPickingOrderIssues(
                listOf(PO1 to null),
                PickingIssueInput(reason = "cannot_divide", qty = null, packSize = 0, note = null),
                "user-1",
            )
        }
        // Trimming: note and remark stored trimmed.
        repo.reportPickingOrderIssues(
            listOf(PO1 to "  box damaged  "),
            PickingIssueInput(reason = "cannot_divide", qty = null, packSize = 6, note = "  odd carton  "),
            "user-1",
        )
        assertEquals("odd carton", stringQuery("SELECT issue_note FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("box damaged", stringQuery("SELECT issue_remark FROM picking_orders WHERE id = '$PO1'"))
        assertEquals(6, intQuery("SELECT issue_pack_size FROM picking_orders WHERE id = '$PO1'"))
        assertNull(stringQuery("SELECT issue_qty FROM picking_orders WHERE id = '$PO1'"))
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
        private const val PART = "bbbb1000-0000-0000-0000-000000000001"
        private const val PO1 = "eeee1000-0000-0000-0000-000000000001"
        private const val PO2 = "eeee1000-0000-0000-0000-000000000002"
        private const val PO3 = "eeee1000-0000-0000-0000-000000000003"
    }
}
