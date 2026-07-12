package com.docpal.warehousepda.data

import android.content.Context
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.AllocationDistributor
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReceivingRepositoryTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: ReceivingRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        repo = ReceivingRepository(db)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `list in_hand orders sorted by delivery date with remaining counts`() = runBlocking {
        val orders = repo.listOrders("in_hand")
        assertTrue(orders.isNotEmpty())
        assertTrue(orders.all { it.status == "in_hand" })
        val dates = orders.map { it.deliveryDate }
        assertEquals(dates.sortedWith(nullsLast()), dates)

        // The seeded in_hand order: remainingItems must equal the count of its
        // items with available > 0 (same availability math as the detail path).
        val expectedRemaining = offMainThread {
            repo.availableQtyByItem(SEEDED_IN_HAND_ORDER_ID).count { it.value > 0 }
        }
        val seeded = orders.first { it.id == SEEDED_IN_HAND_ORDER_ID }
        assertEquals(expectedRemaining, seeded.remainingItems)
    }

    @Test
    fun `list filters by status`() = runBlocking {
        assertTrue(repo.listOrders("pending").all { it.status == "pending" })
        assertTrue(repo.listOrders("clear").all { it.status == "clear" })
        val all = repo.listOrders("all")
        assertEquals(
            repo.listOrders("pending").size + repo.listOrders("in_hand").size + repo.listOrders("clear").size,
            all.size,
        )
    }

    @Test
    fun `detail assembles invoices, mismatches, allocatedByItem, picking rows, packages, boxes`() = runBlocking {
        val detail = repo.getOrderDetail(SEEDED_IN_HAND_ORDER_ID)
        assertEquals(SEEDED_IN_HAND_ORDER_ID, detail.id)
        assertEquals("04958166", detail.refNo)
        assertNotNull(detail.supplierName)
        assertTrue(detail.invoices.isNotEmpty())
        // The seed ships 73 order-level allocations, so picking rows exist.
        assertTrue(detail.pickingRows.isNotEmpty())

        // allocatedQty per item must match AllocationDistributor output for the same inputs.
        val expectedAllocated = offMainThread {
            val dao = db.receivingDao()
            val order = dao.orderById(SEEDED_IN_HAND_ORDER_ID)!!
            val rows = dao.detailItemRows(SEEDED_IN_HAND_ORDER_ID)
            val totals = dao.orderAllocationTotals()
                .associate { (it.receivingOrderId to it.partId) to it.totalQty }
            val unboxed = dao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
            AllocationDistributor.distribute(
                rows.map {
                    AllocationDistributor.InvoiceItemRow(
                        id = it.itemId,
                        partId = it.partId,
                        receivingOrderId = SEEDED_IN_HAND_ORDER_ID,
                        grossQty = it.receivedQty - it.pickedQty - it.putAwayQty,
                        deliveryDate = order.deliveryDate,
                        invoiceNo = it.invoiceNo,
                        dateCode = it.dateCode,
                    )
                },
                totals,
                unboxed,
            ).mapValues { it.value.allocatedQty }
        }
        val actualAllocated = detail.invoices.flatMap { it.items }.associate { it.id to it.allocatedQty }
        assertEquals(expectedAllocated, actualAllocated)

        // remainingItems on the detail mirrors the list count.
        val expectedRemaining = offMainThread {
            repo.availableQtyByItem(SEEDED_IN_HAND_ORDER_ID).count { it.value > 0 }
        }
        assertEquals(expectedRemaining, detail.remainingItems)
    }

    @Test
    fun `tryMarkClear flips in_hand order to clear when fully consumed, and back`() {
        // Seed has no fully-consumed order; insert one (received 10, picked 10 -> available 0).
        offMainThread {
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_orders (id, ref_no, supplier_id, delivery_date, status, arrived_at, arrived_by, created_at, updated_at) " +
                    "VALUES ('11111111-1111-1111-1111-111111111111', 'TEST-CLEAR-01', NULL, 1783612800000, 'in_hand', NULL, NULL, 1783779245783, 1783779245783)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id) " +
                    "VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'TEST-CLEAR-01-W-01', NULL)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, po_no, po_line, qty, received_qty, picked_qty, put_away_qty, box_id, date_code, lot_code, coo, cow) " +
                    "VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'cd426b37-aac4-4e4d-a979-c20738741e65', NULL, NULL, 10, 10, 10, 0, NULL, NULL, NULL, NULL, NULL)"
            )
        }

        offMainThread { repo.tryMarkClear("11111111-1111-1111-1111-111111111111", "tester") }
        assertEquals("clear", statusOf("11111111-1111-1111-1111-111111111111"))
        assertEquals(1, transitionLogCount("11111111-1111-1111-1111-111111111111", "clear"))

        // Item regains availability (picked 10 -> 5): order must flip back to in_hand.
        offMainThread {
            db.openHelper.writableDatabase.execSQL(
                "UPDATE receiving_invoice_items SET picked_qty = 5 WHERE id = '33333333-3333-3333-3333-333333333333'"
            )
        }
        offMainThread { repo.tryMarkInHand("11111111-1111-1111-1111-111111111111", "tester") }
        assertEquals("in_hand", statusOf("11111111-1111-1111-1111-111111111111"))
        assertEquals(1, transitionLogCount("11111111-1111-1111-1111-111111111111", "in_hand"))
    }

    private fun statusOf(orderId: String): String? = offMainThread {
        db.query(SimpleSQLiteQuery("SELECT status FROM receiving_orders WHERE id = '$orderId'")).use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }

    private fun transitionLogCount(orderId: String, toState: String): Int = offMainThread {
        db.query(
            SimpleSQLiteQuery(
                "SELECT COUNT(*) FROM transition_logs " +
                    "WHERE entity_type = 'receiving_order' AND entity_id = '$orderId' AND to_state = '$toState'"
            )
        ).use { c ->
            c.moveToFirst()
            c.getInt(0)
        }
    }

    private fun <T : Comparable<T>> nullsLast() = compareBy<T?> { it == null }.thenBy { it }

    companion object {
        // Only seeded receiving order (status in_hand, 73 order-level allocations).
        private const val SEEDED_IN_HAND_ORDER_ID = "b55df3d8-bd2a-43d5-80fa-616a7058439a"
    }
}
