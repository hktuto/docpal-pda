package com.docpal.warehousepda.data

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.PutAwayRepository
import com.docpal.warehousepda.domain.expectCode
import com.docpal.warehousepda.domain.insertAllocation
import com.docpal.warehousepda.domain.insertInventoryLot
import com.docpal.warehousepda.domain.insertPart
import com.docpal.warehousepda.domain.insertPutAwayScan
import com.docpal.warehousepda.domain.insertReceivingInvoice
import com.docpal.warehousepda.domain.insertReceivingInvoiceItem
import com.docpal.warehousepda.domain.insertReceivingOrder
import com.docpal.warehousepda.domain.insertShelf
import com.docpal.warehousepda.domain.insertShelfBox
import com.docpal.warehousepda.domain.intQuery
import com.docpal.warehousepda.domain.stringQuery
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Put-away box assignment mutations (web apps/api/src/db/putAway.ts assignScanToBox /
 * addAllUnboxedToBox / removeScanFromBox / closeShelfBox / cancelShelfBox /
 * tryMarkReceivingOrderClear): lot materialization on the inventory_lots unique-index
 * columns, removal reversal, close/cancel, and receiving-order auto-clear. Synthetic
 * fixtures only — setUp wipes the seed import.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PutAwayBoxAssignmentTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: PutAwayRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        offMainThread { db.clearAllTables() }
        repo = PutAwayRepository(db)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `assign scan to box materializes lot and source and bumps put away qty`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
            insertShelfBox(wdb, "pa-box-1", "pa-order-1", "A-01-01")
            insertPutAwayScan(
                wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 4,
                dateCode = "DC1", lotCode = "LOT1", coo = "CN", cow = "TW",
            )
        }

        repo.assignScanToBox("pa-scan-1", "pa-box-1", "actor-1")

        assertEquals("pa-box-1", scanColumn("shelf_box_id", "pa-scan-1"))
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM inventory_lots"))
        assertEquals("pa-part-1", stringQuery(db, "SELECT part_id FROM inventory_lots"))
        assertEquals("A-01-01", stringQuery(db, "SELECT shelf_code FROM inventory_lots"))
        assertEquals("pa-box-1", stringQuery(db, "SELECT box_id FROM inventory_lots"))
        assertEquals("DC1", stringQuery(db, "SELECT date_code FROM inventory_lots"))
        assertEquals("LOT1", stringQuery(db, "SELECT lot_code FROM inventory_lots"))
        assertEquals("CN", stringQuery(db, "SELECT coo FROM inventory_lots"))
        assertEquals("TW", stringQuery(db, "SELECT cow FROM inventory_lots"))
        assertEquals(4, intQuery(db, "SELECT total_qty FROM inventory_lots"))
        assertEquals(0, intQuery(db, "SELECT allocated_qty FROM inventory_lots"))
        assertEquals(4, intQuery(db, "SELECT available_qty FROM inventory_lots"))
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM inventory_lot_sources"))
        assertEquals(4, intQuery(db, "SELECT qty FROM inventory_lot_sources"))
        assertEquals(
            "pa-item-1",
            stringQuery(db, "SELECT receiving_invoice_item_id FROM inventory_lot_sources"),
        )
        // The source row points at the materialized lot.
        assertEquals(
            stringQuery(db, "SELECT id FROM inventory_lots"),
            stringQuery(db, "SELECT inventory_lot_id FROM inventory_lot_sources"),
        )
        assertEquals(
            4,
            intQuery(db, "SELECT put_away_qty FROM receiving_invoice_items WHERE id = 'pa-item-1'"),
        )
        // Remaining availability (10 - 4) keeps the order in_hand; no clear, no logs.
        assertEquals("in_hand", stringQuery(db, "SELECT status FROM receiving_orders WHERE id = 'pa-order-1'"))
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM transition_logs"))
    }

    @Test
    fun `assign merges into existing lot on the index columns`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
            insertShelfBox(wdb, "pa-box-1", "pa-order-1", "A-01-01")
            insertPutAwayScan(
                wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 2,
                dateCode = "DC1", lotCode = "LOT-NEW", coo = "CN", cow = "TW",
            )
        }
        // Same part/date/coo/cow/shelf/box but a DIFFERENT lot_code: lot_code is not part of
        // the merge key, so the scan must merge into this lot instead of inserting a new row.
        insertInventoryLot(
            db, "pa-lot-1", "pa-part-1", total = 3, allocated = 0,
            shelfCode = "A-01-01", boxId = "pa-box-1",
            dateCode = "DC1", lotCode = "LOT-OLD", coo = "CN", cow = "TW",
        )

        repo.assignScanToBox("pa-scan-1", "pa-box-1", "actor-1")

        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM inventory_lots"))
        assertEquals(5, intQuery(db, "SELECT total_qty FROM inventory_lots WHERE id = 'pa-lot-1'"))
        assertEquals(5, intQuery(db, "SELECT available_qty FROM inventory_lots WHERE id = 'pa-lot-1'"))
        assertEquals("LOT-OLD", stringQuery(db, "SELECT lot_code FROM inventory_lots WHERE id = 'pa-lot-1'"))
        assertEquals(2, intQuery(db, "SELECT qty FROM inventory_lot_sources"))
    }

    @Test
    fun `assign rejects wrong order box and closed box`() = runBlocking {
        insertReceivingOrder(db, "pa-order-a", "PA-A", "in_hand")
        insertReceivingOrder(db, "pa-order-b", "PA-B", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-a", "pa-order-a")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-a", "pa-part-1", qty = 10)
            insertShelfBox(wdb, "pa-box-b", "pa-order-b", "A-01-01")
            insertShelfBox(wdb, "pa-box-closed", "pa-order-a", "A-01-01", status = "closed")
            insertPutAwayScan(wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 4)
        }

        expectCode("item_does_not_belong_to_receiving_order") {
            repo.assignScanToBox("pa-scan-1", "pa-box-b", "actor-1")
        }
        expectCode("shelf_box_is_not_open") {
            repo.assignScanToBox("pa-scan-1", "pa-box-closed", "actor-1")
        }
        assertNull(scanColumn("shelf_box_id", "pa-scan-1"))
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM inventory_lots"))
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM inventory_lot_sources"))
    }

    @Test
    fun `add all assigns oldest first and returns count`() = runBlocking {
        insertReceivingOrder(db, "pa-order-a", "PA-A", "in_hand")
        insertReceivingOrder(db, "pa-order-b", "PA-B", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-a", "pa-order-a")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-a", "pa-part-1", qty = 20)
            insertShelfBox(wdb, "pa-box-1", "pa-order-a", "A-01-01")
            insertShelfBox(wdb, "pa-box-closed", "pa-order-a", "A-01-01", status = "closed")
            // Insertion order scrambled vs created_at: assignment must follow created_at ASC, id.
            insertPutAwayScan(wdb, "pa-scan-3", itemId = "pa-item-1", partId = "pa-part-1", qty = 2, createdAt = 300)
            insertPutAwayScan(wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 2, createdAt = 100)
            insertPutAwayScan(wdb, "pa-scan-2", itemId = "pa-item-1", partId = "pa-part-1", qty = 2, createdAt = 200)
            // Older unboxed scan of ANOTHER order: web parity filters add-all to the box's order.
            insertReceivingInvoice(wdb, "pa-inv-b", "pa-order-b")
            insertReceivingInvoiceItem(wdb, "pa-item-b", "pa-inv-b", "pa-part-1", qty = 10)
            insertPutAwayScan(wdb, "pa-scan-b", itemId = "pa-item-b", partId = "pa-part-1", qty = 5, createdAt = 50)
        }

        val count = repo.addAllUnboxedToBox("pa-box-1", "actor-1")

        expectCode("shelf_box_is_not_open") {
            repo.addAllUnboxedToBox("pa-box-closed", "actor-1")
        }
        expectCode("shelf_box_not_found") {
            repo.addAllUnboxedToBox("no-such-box", "actor-1")
        }
        assertEquals(3, count)
        assertEquals(3, intQuery(db, "SELECT COUNT(*) FROM put_away_scans WHERE shelf_box_id = 'pa-box-1'"))
        // The other order's unboxed scan is untouched (web addAllUnboxedToBox filters by order).
        assertNull(scanColumn("shelf_box_id", "pa-scan-b"))
    }

    @Test
    fun `remove from box reverses lot source and put away qty`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
            insertShelfBox(wdb, "pa-box-1", "pa-order-1", "A-01-01")
            insertPutAwayScan(
                wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 4,
                dateCode = "DC1", lotCode = "LOT1", coo = "CN", cow = "TW",
            )
        }
        repo.assignScanToBox("pa-scan-1", "pa-box-1", "actor-1")
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM inventory_lots"))
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM inventory_lot_sources"))

        repo.removeScanFromBox("pa-scan-1", "actor-1")

        assertNull(scanColumn("shelf_box_id", "pa-scan-1"))
        assertEquals(0, intQuery(db, "SELECT verified FROM put_away_scans WHERE id = 'pa-scan-1'"))
        // Lot total and source qty both hit 0: both rows are deleted.
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM inventory_lots"))
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM inventory_lot_sources"))
        assertEquals(
            0,
            intQuery(db, "SELECT put_away_qty FROM receiving_invoice_items WHERE id = 'pa-item-1'"),
        )
    }

    @Test
    fun `remove from box refuses when lot has allocations`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
            insertShelfBox(wdb, "pa-box-1", "pa-order-1", "A-01-01")
            insertPutAwayScan(wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 4)
        }
        repo.assignScanToBox("pa-scan-1", "pa-box-1", "actor-1")
        val lotId = stringQuery(db, "SELECT id FROM inventory_lots")!!
        insertAllocation(db, "pa-alloc-1", "pa-picking-item-1", lotId = lotId, qty = 1)

        expectCode("lot_has_pick_allocations") {
            repo.removeScanFromBox("pa-scan-1", "actor-1")
        }

        // Guard throws inside the transaction: the scan stays boxed and the lot untouched.
        assertEquals("pa-box-1", scanColumn("shelf_box_id", "pa-scan-1"))
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM inventory_lots"))
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM inventory_lot_sources"))
        assertEquals(
            4,
            intQuery(db, "SELECT put_away_qty FROM receiving_invoice_items WHERE id = 'pa-item-1'"),
        )
    }

    @Test
    fun `close box requires items and logs`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
            insertShelfBox(wdb, "pa-box-empty", "pa-order-1", "A-01-01")
            insertShelfBox(wdb, "pa-box-1", "pa-order-1", "A-01-01")
            insertPutAwayScan(wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 4)
        }

        expectCode("cannot_close_empty_shelf_box") {
            repo.closeShelfBox("pa-box-empty", "actor-1")
        }

        repo.assignScanToBox("pa-scan-1", "pa-box-1", "actor-1")
        repo.closeShelfBox("pa-box-1", "actor-1")

        assertEquals("closed", stringQuery(db, "SELECT status FROM shelf_boxes WHERE id = 'pa-box-1'"))
        assertEquals(
            "shelf_box",
            stringQuery(db, "SELECT entity_type FROM transition_logs WHERE entity_id = 'pa-box-1'"),
        )
        assertEquals(
            "open",
            stringQuery(db, "SELECT from_state FROM transition_logs WHERE entity_id = 'pa-box-1'"),
        )
        assertEquals(
            "closed",
            stringQuery(db, "SELECT to_state FROM transition_logs WHERE entity_id = 'pa-box-1'"),
        )
        assertEquals(
            "actor-1",
            stringQuery(db, "SELECT actor_id FROM transition_logs WHERE entity_id = 'pa-box-1'"),
        )
        // Remaining availability keeps the order in_hand: close alone does not clear it.
        assertEquals("in_hand", stringQuery(db, "SELECT status FROM receiving_orders WHERE id = 'pa-order-1'"))
    }

    @Test
    fun `cancel box hard deletes with cancelled log`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
            insertShelfBox(wdb, "pa-box-1", "pa-order-1", "A-01-01")
            insertShelfBox(wdb, "pa-box-2", "pa-order-1", "A-01-01")
            insertPutAwayScan(
                wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 4,
                shelfBoxId = "pa-box-2",
            )
        }

        repo.cancelShelfBox("pa-box-1", "actor-1")

        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM shelf_boxes WHERE id = 'pa-box-1'"))
        // The cancelled id survives in transition_logs (nextShelfBoxId never reissues it).
        assertEquals(
            "open",
            stringQuery(db, "SELECT from_state FROM transition_logs WHERE entity_id = 'pa-box-1'"),
        )
        assertEquals(
            "cancelled",
            stringQuery(db, "SELECT to_state FROM transition_logs WHERE entity_id = 'pa-box-1'"),
        )
        assertEquals(
            "actor-1",
            stringQuery(db, "SELECT actor_id FROM transition_logs WHERE entity_id = 'pa-box-1'"),
        )

        expectCode("shelf_box_is_not_empty") {
            repo.cancelShelfBox("pa-box-2", "actor-1")
        }
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM shelf_boxes WHERE id = 'pa-box-2'"))
    }

    @Test
    fun `order auto clears when last item put away`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            // item-1 is already fully put away; item-2 gets its last piece boxed below.
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 5, putAwayQty = 5)
            insertReceivingInvoiceItem(wdb, "pa-item-2", "pa-inv-1", "pa-part-1", qty = 4)
            insertShelfBox(wdb, "pa-box-1", "pa-order-1", "A-01-01")
            insertPutAwayScan(wdb, "pa-scan-1", itemId = "pa-item-2", partId = "pa-part-1", qty = 4)
        }

        repo.assignScanToBox("pa-scan-1", "pa-box-1", "actor-1")

        assertEquals("clear", stringQuery(db, "SELECT status FROM receiving_orders WHERE id = 'pa-order-1'"))
        assertEquals(
            "receiving_order",
            stringQuery(db, "SELECT entity_type FROM transition_logs WHERE entity_id = 'pa-order-1'"),
        )
        assertEquals(
            "in_hand",
            stringQuery(db, "SELECT from_state FROM transition_logs WHERE entity_id = 'pa-order-1'"),
        )
        assertEquals(
            "clear",
            stringQuery(db, "SELECT to_state FROM transition_logs WHERE entity_id = 'pa-order-1'"),
        )
        assertEquals(
            "actor-1",
            stringQuery(db, "SELECT actor_id FROM transition_logs WHERE entity_id = 'pa-order-1'"),
        )
    }

    @Test
    fun `assign rollback on mid-transaction failure`() = runBlocking {
        insertReceivingOrder(db, "pa-order-a", "PA-A", "in_hand")
        insertReceivingOrder(db, "pa-order-b", "PA-B", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-a", "pa-order-a")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-a", "pa-part-1", qty = 10)
            insertReceivingInvoice(wdb, "pa-inv-b", "pa-order-b")
            insertReceivingInvoiceItem(wdb, "pa-item-2", "pa-inv-b", "pa-part-1", qty = 10)
            insertShelfBox(wdb, "pa-box-1", "pa-order-a", "A-01-01")
            insertPutAwayScan(wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 2)
            insertPutAwayScan(wdb, "pa-scan-2", itemId = "pa-item-2", partId = "pa-part-1", qty = 3)
        }

        // addAllUnboxedToBox iterates only the box's order (web parity: its selection and the
        // assign order check derive the order through the same join, so a selected scan can
        // never fail the order check). The single-transaction rollback it relies on is proven
        // here by driving two tx-internal assigns in one transaction: the first succeeds, the
        // second hits item_does_not_belong_to_receiving_order.
        offMainThread {
            try {
                db.runInTransaction {
                    repo.assignScanToBoxInternal("pa-scan-1", "pa-box-1", "actor-1")
                    repo.assignScanToBoxInternal("pa-scan-2", "pa-box-1", "actor-1")
                }
                throw AssertionError("expected LocalizedException")
            } catch (e: LocalizedException) {
                assertEquals("item_does_not_belong_to_receiving_order", e.code)
            }
        }

        // The first scan's assignment (and all its side effects) rolled back.
        assertNull(scanColumn("shelf_box_id", "pa-scan-1"))
        assertNull(scanColumn("shelf_box_id", "pa-scan-2"))
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM inventory_lots"))
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM inventory_lot_sources"))
        assertEquals(
            0,
            intQuery(db, "SELECT put_away_qty FROM receiving_invoice_items WHERE id = 'pa-item-1'"),
        )
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM transition_logs"))
    }

    /** Batches raw fixture inserts in one off-main-thread block (Room forbids main-thread writes). */
    private fun fixture(block: (SupportSQLiteDatabase) -> Unit) = offMainThread {
        block(db.openHelper.writableDatabase)
    }

    private fun scanColumn(column: String, scanId: String): String? =
        stringQuery(db, "SELECT $column FROM put_away_scans WHERE id = '$scanId'")
}
