package com.docpal.warehousepda.domain

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.ReceivingRepository
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.model.PickingIssueInput
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
            db,
            "INSERT INTO parts (id, part_no, internal_code, description, default_coo) " +
                "VALUES ('$PART', 'TEST-PART-01', '', '', 'CN')"
        )
    }

    @After
    fun tearDown() = db.close()

    /** Order plus a single item of [totalQty] (id "item-<orderId>") — the issue reporter's qty checks need it. */
    private fun insertOrderWithItem(id: String, refNo: String, status: String, totalQty: Int) {
        insertPickingOrder(db, id, refNo, status)
        insertPickingItem(db, "item-$id", id, PART, totalQty)
    }

    @Test
    fun `reports issue on pending order with all fields and log`() = runBlocking {
        insertOrderWithItem(PO1, "TEST-PO-01", "pending", totalQty = 10)
        insertOrderWithItem(PO2, "TEST-PO-02", "pending", totalQty = 8)

        val (reported, skipped) = repo.reportPickingOrderIssues(
            entries = listOf(PO1 to "short by 5", PO2 to null),
            input = PickingIssueInput(reason = "insufficient_stock", qty = 3, packSize = null, note = "truck short"),
            actorId = "user-1",
        )
        assertEquals(2 to 0, reported to skipped)

        // po-1 row: all issue fields set.
        assertEquals("issue", stringQuery(db, "SELECT status FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("insufficient_stock", stringQuery(db, "SELECT issue_reason FROM picking_orders WHERE id = '$PO1'"))
        assertEquals(3, intQuery(db, "SELECT issue_qty FROM picking_orders WHERE id = '$PO1'"))
        assertNull(stringQuery(db, "SELECT issue_pack_size FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("truck short", stringQuery(db, "SELECT issue_note FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("short by 5", stringQuery(db, "SELECT issue_remark FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("user-1", stringQuery(db, "SELECT issue_reported_by FROM picking_orders WHERE id = '$PO1'"))
        assertNotNull(stringQuery(db, "SELECT issue_reported_at FROM picking_orders WHERE id = '$PO1'"))

        // po-2 row: same reason fields, no remark.
        assertEquals("issue", stringQuery(db, "SELECT status FROM picking_orders WHERE id = '$PO2'"))
        assertEquals(3, intQuery(db, "SELECT issue_qty FROM picking_orders WHERE id = '$PO2'"))
        assertNull(stringQuery(db, "SELECT issue_remark FROM picking_orders WHERE id = '$PO2'"))

        // One transition log per order: pending -> issue.
        assertEquals(
            1,
            intQuery(
                db,
                "SELECT COUNT(*) FROM transition_logs " +
                    "WHERE entity_type = 'picking_order' AND entity_id = '$PO1' AND from_state = 'pending' AND to_state = 'issue' AND actor_id = 'user-1'"
            ),
        )
        assertEquals(
            1,
            intQuery(
                db,
                "SELECT COUNT(*) FROM transition_logs " +
                    "WHERE entity_type = 'picking_order' AND entity_id = '$PO2' AND from_state = 'pending' AND to_state = 'issue'"
            ),
        )

        // Metadata JSON carries the web's key names; absent values stay absent.
        val meta1 = JSONObject(
            stringQuery(db, "SELECT metadata FROM transition_logs WHERE entity_id = '$PO1' AND to_state = 'issue'")!!
        )
        assertEquals("insufficient_stock", meta1.getString("reason"))
        assertEquals(3, meta1.getInt("qty"))
        assertEquals("truck short", meta1.getString("note"))
        assertEquals("short by 5", meta1.getString("remark"))
        assertFalse(meta1.has("packSize"))

        val meta2 = JSONObject(
            stringQuery(db, "SELECT metadata FROM transition_logs WHERE entity_id = '$PO2' AND to_state = 'issue'")!!
        )
        assertEquals("insufficient_stock", meta2.getString("reason"))
        assertFalse(meta2.has("remark"))
    }

    @Test
    fun `merge requires at least two orders`() = runBlocking {
        insertOrderWithItem(PO1, "TEST-PO-01", "pending", totalQty = 10)
        expectCode("select_at_least_two_orders_to_merge") {
            repo.reportPickingOrderIssues(
                listOf(PO1 to null),
                PickingIssueInput("merge", null, null, null),
                "user-1",
            )
        }
        // Nothing written.
        assertEquals("pending", stringQuery(db, "SELECT status FROM picking_orders WHERE id = '$PO1'"))
    }

    @Test
    fun `finished and issue orders are skipped`() = runBlocking {
        insertOrderWithItem(PO1, "TEST-PO-01", "finished", totalQty = 10)
        insertOrderWithItem(PO2, "TEST-PO-02", "issue", totalQty = 8)
        insertOrderWithItem(PO3, "TEST-PO-03", "pending", totalQty = 5)

        val (reported, skipped) = repo.reportPickingOrderIssues(
            entries = listOf(PO1 to null, PO2 to null, PO3 to "late truck"),
            input = PickingIssueInput("other", null, null, null),
            actorId = "user-1",
        )
        assertEquals(1 to 2, reported to skipped)

        // Finished / issue rows untouched.
        assertEquals("finished", stringQuery(db, "SELECT status FROM picking_orders WHERE id = '$PO1'"))
        assertNull(stringQuery(db, "SELECT issue_reason FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("issue", stringQuery(db, "SELECT status FROM picking_orders WHERE id = '$PO2'"))
        assertNull(stringQuery(db, "SELECT issue_reason FROM picking_orders WHERE id = '$PO2'"))
        // Pending row reported.
        assertEquals("other", stringQuery(db, "SELECT issue_reason FROM picking_orders WHERE id = '$PO3'"))
        assertEquals("late truck", stringQuery(db, "SELECT issue_remark FROM picking_orders WHERE id = '$PO3'"))
        assertNull(stringQuery(db, "SELECT issue_qty FROM picking_orders WHERE id = '$PO3'"))
        assertNull(stringQuery(db, "SELECT issue_pack_size FROM picking_orders WHERE id = '$PO3'"))
        assertEquals(
            1,
            intQuery(db, "SELECT COUNT(*) FROM transition_logs WHERE entity_id = '$PO3' AND to_state = 'issue'"),
        )
    }

    @Test
    fun `insufficient stock qty must be below order total`() = runBlocking {
        insertOrderWithItem(PO1, "TEST-PO-01", "pending", totalQty = 10)
        val e = expectCode("actual_qty_must_be_less_than_requested") {
            repo.reportPickingOrderIssues(
                listOf(PO1 to null),
                PickingIssueInput(reason = "insufficient_stock", qty = 10, packSize = null, note = null),
                "user-1",
            )
        }
        // ref_no param is what ErrorText renders as %1$s.
        assertEquals(mapOf("ref_no" to "TEST-PO-01"), e.params)
        // Nothing written.
        assertEquals("pending", stringQuery(db, "SELECT status FROM picking_orders WHERE id = '$PO1'"))
    }

    @Test
    fun `throw on second order rolls back first order writes`() = runBlocking {
        // PO1 (total 20) passes the 10 < 20 check and is updated + logged first; PO2 (total 10)
        // then throws -> the whole transaction must roll back.
        insertOrderWithItem(PO1, "TEST-PO-01", "pending", totalQty = 20)
        insertOrderWithItem(PO2, "TEST-PO-02", "pending", totalQty = 10)
        expectCode("actual_qty_must_be_less_than_requested") {
            repo.reportPickingOrderIssues(
                listOf(PO1 to "short", PO2 to null),
                PickingIssueInput(reason = "insufficient_stock", qty = 10, packSize = null, note = null),
                "user-1",
            )
        }
        // PO1's UPDATE rolled back.
        assertEquals("pending", stringQuery(db, "SELECT status FROM picking_orders WHERE id = '$PO1'"))
        assertNull(stringQuery(db, "SELECT issue_reason FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("pending", stringQuery(db, "SELECT status FROM picking_orders WHERE id = '$PO2'"))
        // No transition logs written for either order.
        assertEquals(
            0,
            intQuery(db, "SELECT COUNT(*) FROM transition_logs WHERE entity_id IN ('$PO1', '$PO2')"),
        )
    }

    @Test
    fun `no reportable orders throws`() = runBlocking {
        insertOrderWithItem(PO1, "TEST-PO-01", "finished", totalQty = 10)
        insertOrderWithItem(PO2, "TEST-PO-02", "finished", totalQty = 8)
        expectCode("no_reportable_orders_selected") {
            repo.reportPickingOrderIssues(
                listOf(PO1 to null, PO2 to null),
                PickingIssueInput("other", null, null, null),
                "user-1",
            )
        }
        // Nothing written.
        assertEquals("finished", stringQuery(db, "SELECT status FROM picking_orders WHERE id = '$PO1'"))
        assertNull(stringQuery(db, "SELECT issue_reason FROM picking_orders WHERE id = '$PO2'"))
    }

    @Test
    fun `input validation errors match web keys`() = runBlocking {
        insertOrderWithItem(PO1, "TEST-PO-01", "pending", totalQty = 10)
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
        assertEquals("odd carton", stringQuery(db, "SELECT issue_note FROM picking_orders WHERE id = '$PO1'"))
        assertEquals("box damaged", stringQuery(db, "SELECT issue_remark FROM picking_orders WHERE id = '$PO1'"))
        assertEquals(6, intQuery(db, "SELECT issue_pack_size FROM picking_orders WHERE id = '$PO1'"))
        assertNull(stringQuery(db, "SELECT issue_qty FROM picking_orders WHERE id = '$PO1'"))
    }

    companion object {
        private const val PART = "bbbb1000-0000-0000-0000-000000000001"
        private const val PO1 = "eeee1000-0000-0000-0000-000000000001"
        private const val PO2 = "eeee1000-0000-0000-0000-000000000002"
        private const val PO3 = "eeee1000-0000-0000-0000-000000000003"
    }
}
