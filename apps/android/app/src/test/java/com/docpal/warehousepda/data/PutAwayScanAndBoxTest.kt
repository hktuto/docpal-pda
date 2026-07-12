package com.docpal.warehousepda.data

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.PutAwayRepository
import com.docpal.warehousepda.domain.expectCode
import com.docpal.warehousepda.domain.insertPart
import com.docpal.warehousepda.domain.insertPutAwayScan
import com.docpal.warehousepda.domain.insertReceivingInvoice
import com.docpal.warehousepda.domain.insertReceivingInvoiceItem
import com.docpal.warehousepda.domain.insertReceivingOrder
import com.docpal.warehousepda.domain.insertShelf
import com.docpal.warehousepda.domain.insertShelfBox
import com.docpal.warehousepda.domain.insertTransitionLog
import com.docpal.warehousepda.domain.intQuery
import com.docpal.warehousepda.domain.stringQuery
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Put-away scan + shelf-box mutations (web apps/web/db/putAway.ts recordPutAwayScan /
 * createShelfBox / removeScannedPiece; API apps/api/src/db/putAway.ts for nextShelfBoxId
 * parity). Synthetic fixtures only — setUp wipes the seed import.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PutAwayScanAndBoxTest {

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
    fun `record scan inserts unboxed row with item part`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
        }

        val scanId = repo.recordPutAwayScan("pa-item-1", 4, "DC1", "LOT1", "CN", "TW")

        assertTrue(scanId.isNotEmpty())
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM put_away_scans"))
        assertEquals("pa-item-1", scanColumn("receiving_invoice_item_id", scanId))
        assertEquals("pa-part-1", scanColumn("part_id", scanId))
        assertEquals(4, intQuery(db, "SELECT qty FROM put_away_scans WHERE id = '$scanId'"))
        assertNull(scanColumn("shelf_box_id", scanId))
        assertEquals(0, intQuery(db, "SELECT verified FROM put_away_scans WHERE id = '$scanId'"))
        assertEquals("DC1", scanColumn("date_code", scanId))
        assertEquals("LOT1", scanColumn("lot_code", scanId))
        assertEquals("CN", scanColumn("coo", scanId))
        assertEquals("TW", scanColumn("cow", scanId))
        // No status changes, no clear check, no logs.
        assertEquals("in_hand", stringQuery(db, "SELECT status FROM receiving_orders WHERE id = 'pa-order-1'"))
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM transition_logs"))
    }

    @Test
    fun `record scan rejects non positive qty`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
        }

        expectCode("qty_must_be_positive_integer") {
            repo.recordPutAwayScan("pa-item-1", 0, null, null, null, null)
        }
        expectCode("qty_must_be_positive_integer") {
            repo.recordPutAwayScan("pa-item-1", -2, null, null, null, null)
        }
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM put_away_scans"))
    }

    @Test
    fun `record scan rejects qty above remaining`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            // received_qty defaults to qty: remaining is 5.
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 5)
        }

        expectCode("scanned_qty_exceeds_total") {
            repo.recordPutAwayScan("pa-item-1", 6, null, null, null, null)
        }
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM put_away_scans"))
    }

    @Test
    fun `record scan remaining shrinks with existing scans`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 5)
        }

        repo.recordPutAwayScan("pa-item-1", 3, null, null, null, null)
        // The remaining-check integration path: the first unboxed scan must be subtracted
        // via ReceivingAvailability.byItem (ReceivingDao.unboxedPutAwayScanTotals).
        expectCode("scanned_qty_exceeds_total") {
            repo.recordPutAwayScan("pa-item-1", 3, null, null, null, null)
        }
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM put_away_scans"))

        repo.recordPutAwayScan("pa-item-1", 2, null, null, null, null)
        assertEquals(2, intQuery(db, "SELECT COUNT(*) FROM put_away_scans WHERE shelf_box_id IS NULL"))
        assertEquals(
            5,
            intQuery(db, "SELECT COALESCE(SUM(qty), 0) FROM put_away_scans WHERE shelf_box_id IS NULL"),
        )
    }

    @Test
    fun `record scan unknown item throws`() = runBlocking {
        expectCode("invoice_item_not_found") {
            repo.recordPutAwayScan("no-such-item", 1, null, null, null, null)
        }
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM put_away_scans"))
    }

    @Test
    fun `create shelf box assigns sequential SBOX id and logs`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelfBox(wdb, "SBOX-0003", "pa-order-1", "A-01-01")
            // Cancelled boxes are hard-deleted; their ids survive only in transition_logs
            // and must never be reissued (API nextShelfBoxId parity).
            insertTransitionLog(wdb, "shelf_box", "SBOX-0005", "open", "cancelled", "actor-1")
        }

        val boxId = repo.createShelfBox("pa-order-1", "A-01-01", "actor-1")

        assertEquals("SBOX-0006", boxId)
        assertEquals("open", stringQuery(db, "SELECT status FROM shelf_boxes WHERE id = 'SBOX-0006'"))
        assertEquals("A-01-01", stringQuery(db, "SELECT shelf_code FROM shelf_boxes WHERE id = 'SBOX-0006'"))
        assertEquals("pa-order-1", stringQuery(db, "SELECT receiving_order_id FROM shelf_boxes WHERE id = 'SBOX-0006'"))
        assertEquals("shelf_box", stringQuery(db, "SELECT entity_type FROM transition_logs WHERE entity_id = 'SBOX-0006'"))
        assertNull(stringQuery(db, "SELECT from_state FROM transition_logs WHERE entity_id = 'SBOX-0006'"))
        assertEquals("open", stringQuery(db, "SELECT to_state FROM transition_logs WHERE entity_id = 'SBOX-0006'"))
        assertEquals("actor-1", stringQuery(db, "SELECT actor_id FROM transition_logs WHERE entity_id = 'SBOX-0006'"))
    }

    @Test
    fun `create shelf box validates order and shelf`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        fixture { wdb -> insertShelf(wdb, "A-01-01", "A") }

        expectCode("shelf_not_found") { repo.createShelfBox("pa-order-1", "NO-SHELF", "actor-1") }
        expectCode("receiving_order_not_found") { repo.createShelfBox("no-such-order", "A-01-01", "actor-1") }
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM shelf_boxes"))
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM transition_logs"))
    }

    @Test
    fun `remove scanned piece deletes unboxed only`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
            insertShelfBox(wdb, "pa-box-1", "pa-order-1", null)
            insertPutAwayScan(wdb, "pa-scan-unboxed", itemId = "pa-item-1", partId = "pa-part-1", qty = 4)
            insertPutAwayScan(
                wdb, "pa-scan-boxed", itemId = "pa-item-1", partId = "pa-part-1", qty = 3,
                shelfBoxId = "pa-box-1",
            )
        }

        repo.removeScannedPiece("pa-scan-unboxed")
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM put_away_scans WHERE id = 'pa-scan-unboxed'"))

        expectCode("put_away_scan_not_found") { repo.removeScannedPiece("no-such-scan") }
        expectCode("put_away_scan_already_boxed") { repo.removeScannedPiece("pa-scan-boxed") }
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM put_away_scans WHERE id = 'pa-scan-boxed'"))
    }

    /** Batches raw fixture inserts in one off-main-thread block (Room forbids main-thread writes). */
    private fun fixture(block: (SupportSQLiteDatabase) -> Unit) = offMainThread {
        block(db.openHelper.writableDatabase)
    }

    private fun scanColumn(column: String, scanId: String): String? =
        stringQuery(db, "SELECT $column FROM put_away_scans WHERE id = '$scanId'")
}
