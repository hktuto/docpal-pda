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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Pure tests for the date-code rule parser/matcher (no Android runtime needed). */
class AllocatorTest {

    @Test
    fun `parseDateCodeRule`() {
        assertNull(Allocator.parseDateCodeRule(null))
        assertNull(Allocator.parseDateCodeRule("   "))
        assertNull(Allocator.parseDateCodeRule(">=")) // empty value
        assertEquals(Allocator.DateCodeRule("eq", "2406"), Allocator.parseDateCodeRule("2406"))
        assertEquals(Allocator.DateCodeRule("eq", "2406"), Allocator.parseDateCodeRule(" 2406 "))
        assertEquals(Allocator.DateCodeRule(">=", "2406"), Allocator.parseDateCodeRule(">=2406"))
        assertEquals(Allocator.DateCodeRule("<=", "2406"), Allocator.parseDateCodeRule("<=2406"))
        assertEquals(Allocator.DateCodeRule(">", "2406"), Allocator.parseDateCodeRule(">2406"))
        assertEquals(Allocator.DateCodeRule("<", "2406"), Allocator.parseDateCodeRule("<2406"))
    }

    @Test
    fun `dateCodeMatches semantics`() {
        val ge = Allocator.parseDateCodeRule(">=2406")
        assertTrue(Allocator.dateCodeMatches(null, ge)) // null lot date matches any rule
        assertTrue(Allocator.dateCodeMatches(null, null)) // no rule matches everything
        assertTrue(Allocator.dateCodeMatches("2407", ge))
        assertFalse(Allocator.dateCodeMatches("2405", ge))
        assertTrue(Allocator.dateCodeMatches("2406", Allocator.parseDateCodeRule("2406")))
        assertFalse(Allocator.dateCodeMatches("2406", Allocator.parseDateCodeRule("<2406")))
    }
}

/** Seeded-DB tests for allocation and confirm arrival. Same setup as ReceivingRepositoryTest. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AllocatorDbTest {

    private lateinit var db: AppDatabase
    private lateinit var allocator: Allocator
    private lateinit var repo: ReceivingRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        allocator = Allocator(db)
        repo = ReceivingRepository(db, allocator)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `confirm arrival moves pending order to in_hand with expected received qty`() = runBlocking {
        insertPendingReceivingOrder(RECV_ORDER, RECV_INVOICE)
        insertReceivingItem(RECV_ITEM_1, RECV_INVOICE, PART_1, qty = 10)
        insertReceivingItem(RECV_ITEM_2, RECV_INVOICE, PART_2, qty = 5)

        repo.confirmArrived(RECV_ORDER, ACTOR)

        val after = offMainThread { db.receivingDao().orderById(RECV_ORDER)!! }
        assertEquals("in_hand", after.status)
        assertNotNull(after.arrivedAt)
        assertEquals(ACTOR, after.arrivedBy)
        assertEquals(10, intQuery("SELECT received_qty FROM receiving_invoice_items WHERE id = '$RECV_ITEM_1'"))
        assertEquals(5, intQuery("SELECT received_qty FROM receiving_invoice_items WHERE id = '$RECV_ITEM_2'"))
        assertEquals(
            1,
            intQuery(
                "SELECT COUNT(*) FROM transition_logs WHERE entity_type = 'receiving_order' " +
                    "AND entity_id = '$RECV_ORDER' AND from_state = 'pending' AND to_state = 'in_hand'"
            ),
        )
    }

    @Test
    fun `confirm arrival twice rejected with already_status`() = runBlocking {
        insertPendingReceivingOrder(RECV_ORDER, RECV_INVOICE)
        insertReceivingItem(RECV_ITEM_1, RECV_INVOICE, PART_1, qty = 10)

        repo.confirmArrived(RECV_ORDER, ACTOR)
        val e = assertThrows(LocalizedException::class.java) {
            runBlocking { repo.confirmArrived(RECV_ORDER, ACTOR) }
        }
        assertEquals("receiving_order_already_status", e.code)
        assertEquals("in_hand", e.params["status"])
    }

    @Test
    fun `confirm arrival rejects missing order`() = runBlocking {
        val e = assertThrows(LocalizedException::class.java) {
            runBlocking { repo.confirmArrived("ffffffff-ffff-ffff-ffff-ffffffffffff", ACTOR) }
        }
        assertEquals("receiving_order_not_found", e.code)
    }

    @Test
    fun `confirm arrival respects active mismatch effective qty and skips zero writes`() = runBlocking {
        insertPendingReceivingOrder(RECV_ORDER, RECV_INVOICE)
        insertReceivingItem(RECV_ITEM_1, RECV_INVOICE, PART_1, qty = 10)
        insertReceivingItem(RECV_ITEM_2, RECV_INVOICE, PART_2, qty = 5)

        val mismatchRepo = MismatchRepository(db, repo)
        mismatchRepo.reportMismatch(RECV_ITEM_1, ACTOR, MismatchRules.NOT_FOUND, null, null, "gone")

        repo.confirmArrived(RECV_ORDER, ACTOR)

        // not_found -> effective 0 -> write skipped, received_qty stays 0.
        assertEquals(0, intQuery("SELECT received_qty FROM receiving_invoice_items WHERE id = '$RECV_ITEM_1'"))
        // Sibling item received normally.
        assertEquals(5, intQuery("SELECT received_qty FROM receiving_invoice_items WHERE id = '$RECV_ITEM_2'"))
        assertEquals("in_hand", stringQuery("SELECT status FROM receiving_orders WHERE id = '$RECV_ORDER'"))
    }

    @Test
    fun `allocation after confirm arrival fills pending picking order from receiving area`() = runBlocking {
        insertPendingReceivingOrder(RECV_ORDER, RECV_INVOICE)
        insertReceivingItem(RECV_ITEM_1, RECV_INVOICE, PART_1, qty = 100, boxId = "BOX-1")
        insertPendingPickingOrder(PICK_ORDER)
        insertPickingItem(PICK_ITEM_1, PICK_ORDER, PART_1, qty = 60)

        repo.confirmArrived(RECV_ORDER, ACTOR)

        // Allocation row against the receiving order, qty = min(needed 60, available 100).
        assertEquals(
            1,
            intQuery(
                "SELECT COUNT(*) FROM allocations WHERE picking_item_id = '$PICK_ITEM_1' " +
                    "AND receiving_order_id = '$RECV_ORDER' AND qty = 60"
            ),
        )
        assertEquals(
            "[\"BOX-1\"]",
            stringQuery("SELECT remark FROM allocations WHERE picking_item_id = '$PICK_ITEM_1'"),
        )
        assertEquals(60, intQuery("SELECT allocated_qty FROM picking_items WHERE id = '$PICK_ITEM_1'"))
    }

    @Test
    fun `allocation prefers located lots and respects date code rule`() = runBlocking {
        insertPendingPickingOrder(PICK_ORDER)
        insertPickingItem(PICK_ITEM_1, PICK_ORDER, PART_1, qty = 50, requiredDateCode = ">=2406")
        // Below the rule -> must be skipped even though it has more stock.
        insertLot(LOT_1, PART_1, dateCode = "2405", shelfCode = "S-05", totalQty = 100)
        // Matches the rule.
        insertLot(LOT_2, PART_1, dateCode = "2407", shelfCode = "S-07", totalQty = 30)

        allocator.allocatePickingOrder(PICK_ORDER)

        assertEquals(
            1,
            intQuery(
                "SELECT COUNT(*) FROM allocations WHERE picking_item_id = '$PICK_ITEM_1' " +
                    "AND inventory_lot_id = '$LOT_2' AND qty = 30"
            ),
        )
        assertEquals(0, intQuery("SELECT COUNT(*) FROM allocations WHERE inventory_lot_id = '$LOT_1'"))
        assertEquals(30, intQuery("SELECT allocated_qty FROM inventory_lots WHERE id = '$LOT_2'"))
        assertEquals(0, intQuery("SELECT available_qty FROM inventory_lots WHERE id = '$LOT_2'"))
        assertEquals(0, intQuery("SELECT allocated_qty FROM inventory_lots WHERE id = '$LOT_1'"))
        // Silent partial: only 30 of 50 allocated, no receiving stock for this part.
        assertEquals(30, intQuery("SELECT allocated_qty FROM picking_items WHERE id = '$PICK_ITEM_1'"))
    }

    @Test
    fun `allocation is silent-partial and idempotent`() = runBlocking {
        insertPendingPickingOrder(PICK_ORDER)
        insertPickingItem(PICK_ITEM_1, PICK_ORDER, PART_1, qty = 50)
        insertLot(LOT_1, PART_1, dateCode = null, shelfCode = "S-09", totalQty = 10)

        allocator.allocatePickingOrder(PICK_ORDER)
        assertEquals(1, intQuery("SELECT COUNT(*) FROM allocations WHERE picking_item_id = '$PICK_ITEM_1'"))
        assertEquals(10, intQuery("SELECT allocated_qty FROM picking_items WHERE id = '$PICK_ITEM_1'"))
        assertEquals(10, intQuery("SELECT allocated_qty FROM inventory_lots WHERE id = '$LOT_1'"))
        assertEquals(0, intQuery("SELECT available_qty FROM inventory_lots WHERE id = '$LOT_1'"))

        // Second run: nothing left to allocate, no new rows.
        allocator.allocatePickingOrder(PICK_ORDER)
        assertEquals(1, intQuery("SELECT COUNT(*) FROM allocations WHERE picking_item_id = '$PICK_ITEM_1'"))
        assertEquals(10, intQuery("SELECT allocated_qty FROM picking_items WHERE id = '$PICK_ITEM_1'"))
    }

    private fun exec(sql: String) = offMainThread { db.openHelper.writableDatabase.execSQL(sql) }

    private fun intQuery(sql: String): Int = offMainThread {
        db.query(SimpleSQLiteQuery(sql)).use { c ->
            c.moveToFirst()
            c.getInt(0)
        }
    }

    private fun stringQuery(sql: String): String? = offMainThread {
        db.query(SimpleSQLiteQuery(sql)).use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }

    private fun insertPendingReceivingOrder(orderId: String, invoiceId: String) {
        exec(
            "INSERT INTO receiving_orders (id, ref_no, supplier_id, delivery_date, status, arrived_at, arrived_by, created_at, updated_at) " +
                "VALUES ('$orderId', 'TEST-ARRIVE-01', NULL, 1783612800000, 'pending', NULL, NULL, 1783779245783, 1783779245783)"
        )
        exec(
            "INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id) " +
                "VALUES ('$invoiceId', '$orderId', 'TEST-ARRIVE-01-W-01', NULL)"
        )
    }

    private fun insertReceivingItem(
        itemId: String, invoiceId: String, partId: String, qty: Int, boxId: String? = null,
    ) {
        exec(
            "INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, po_no, po_line, qty, received_qty, picked_qty, put_away_qty, box_id, date_code, lot_code, coo, cow) " +
                "VALUES ('$itemId', '$invoiceId', '$partId', NULL, NULL, $qty, 0, 0, 0, ${boxId?.let { "'$it'" } ?: "NULL"}, NULL, NULL, NULL, NULL)"
        )
    }

    private fun insertPendingPickingOrder(orderId: String) {
        exec(
            "INSERT INTO picking_orders (id, ref_no, supplier_id, delivery_date, po_no, required_date_code_notice, ship_to, destination_country, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark, issue_reported_at, issue_reported_by, status, created_at, updated_at) " +
                "VALUES ('$orderId', 'TEST-PICK-01', NULL, 1783872000000, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pending', 1783779245783, 1783779245783)"
        )
    }

    private fun insertPickingItem(
        itemId: String, orderId: String, partId: String, qty: Int, requiredDateCode: String? = null,
    ) {
        exec(
            "INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, allocated_qty, required_date_code, source_shelf_code) " +
                "VALUES ('$itemId', '$orderId', '$partId', $qty, 0, 0, ${requiredDateCode?.let { "'$it'" } ?: "NULL"}, NULL)"
        )
    }

    private fun insertLot(
        lotId: String, partId: String, dateCode: String?, shelfCode: String, totalQty: Int,
    ) {
        exec(
            "INSERT INTO inventory_lots (id, part_id, date_code, lot_code, coo, cow, shelf_code, box_id, total_qty, allocated_qty, available_qty) " +
                "VALUES ('$lotId', '$partId', ${dateCode?.let { "'$it'" } ?: "NULL"}, NULL, NULL, NULL, '$shelfCode', NULL, $totalQty, 0, $totalQty)"
        )
    }

    companion object {
        private const val ACTOR = "tester"
        // Seeded parts that appear nowhere else in the seed (no lots, no receiving items).
        private const val PART_1 = "cd426b37-aac4-4e4d-a979-c20738741e65"
        private const val PART_2 = "35b1153d-6ed7-438e-9261-0e45a19a4e43"

        private const val RECV_ORDER = "aaaaaaaa-0000-0000-0000-000000000001"
        private const val RECV_INVOICE = "aaaaaaaa-0000-0000-0000-000000000002"
        private const val RECV_ITEM_1 = "aaaaaaaa-0000-0000-0000-000000000003"
        private const val RECV_ITEM_2 = "aaaaaaaa-0000-0000-0000-000000000004"

        private const val PICK_ORDER = "bbbbbbbb-0000-0000-0000-000000000010"
        private const val PICK_ITEM_1 = "bbbbbbbb-0000-0000-0000-000000000011"

        private const val LOT_1 = "cccccccc-0000-0000-0000-000000000021"
        private const val LOT_2 = "cccccccc-0000-0000-0000-000000000022"
    }
}
