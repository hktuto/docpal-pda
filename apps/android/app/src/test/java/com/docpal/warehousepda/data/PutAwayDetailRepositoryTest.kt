package com.docpal.warehousepda.data

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.PutAwayRepository
import com.docpal.warehousepda.domain.exec
import com.docpal.warehousepda.domain.insertAllocation
import com.docpal.warehousepda.domain.insertPart
import com.docpal.warehousepda.domain.insertPickingItem
import com.docpal.warehousepda.domain.insertPickingOrder
import com.docpal.warehousepda.domain.insertPutAwayScan
import com.docpal.warehousepda.domain.insertReceivingInvoice
import com.docpal.warehousepda.domain.insertReceivingInvoiceItem
import com.docpal.warehousepda.domain.insertReceivingOrder
import com.docpal.warehousepda.domain.insertShelf
import com.docpal.warehousepda.domain.insertShelfBox
import com.docpal.warehousepda.domain.insertSupplier
import com.docpal.warehousepda.domain.model.PutAwayBoxContent
import com.docpal.warehousepda.domain.model.ShelfOption
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PutAwayDetailRepositoryTest {

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
    fun `loads header lots scans and boxes`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        exec(db, "UPDATE receiving_orders SET supplier_id = 'pa-sup-1' WHERE id = 'pa-order-1'")
        insertPart(db, "pa-part-1", "PA-PART-1")
        insertPart(db, "pa-part-2", "PA-PART-2")
        fixture { wdb ->
            insertSupplier(wdb, "pa-sup-1", "SUP-ONE", "Supplier One")
            insertShelf(wdb, "A-01-01", "A")
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            // Available lot: qty 10, one unboxed scan (4) + one boxed scan (3).
            insertReceivingInvoiceItem(
                wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10,
                dateCode = "DC1", lotCode = "LOT1", coo = "CN", cow = "TW",
            )
            // Fully put away: no availability, no scans -> filtered out of lots.
            insertReceivingInvoiceItem(wdb, "pa-item-2", "pa-inv-1", "pa-part-2", qty = 5, putAwayQty = 5)
            insertShelfBox(wdb, "pa-box-1", "pa-order-1", "A-01-01")
            insertPutAwayScan(
                wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 4,
                dateCode = "DC1", lotCode = "LOT1", coo = "CN", cow = "TW",
            )
            insertPutAwayScan(
                wdb, "pa-scan-2", itemId = "pa-item-1", partId = "pa-part-1", qty = 3,
                shelfBoxId = "pa-box-1",
            )
        }

        val detail = repo.getPutAwayDetail("pa-order-1") ?: error("expected detail")

        val header = detail.header
        assertEquals("pa-order-1", header.id)
        assertEquals("PA-001", header.refNo)
        assertEquals("in_hand", header.status)
        assertEquals("Supplier One", header.supplierName)
        assertEquals("SUP-ONE", header.supplierCode)
        assertEquals(1783612800000L, header.deliveryDate)

        // Only the lot with availability survives the web HAVING filter.
        assertEquals(1, detail.lots.size)
        val lot = detail.lots.single()
        assertEquals("pa-item-1", lot.receivingInvoiceItemId)
        assertEquals("PA-PART-1", lot.partNo)
        assertEquals("DC1", lot.dateCode)
        assertEquals("LOT1", lot.lotCode)
        assertEquals("CN", lot.coo)
        assertEquals("TW", lot.cow)
        assertEquals(10, lot.totalQty)
        assertEquals(6, lot.availableQty)   // 10 gross - 4 unboxed scan
        assertEquals(7, lot.scannedQty)     // 4 unboxed + 3 boxed
        assertEquals(3, lot.boxedQty)

        // Scans ordered by created_at, id (fixture shares one timestamp -> id tiebreak).
        assertEquals(listOf("pa-scan-1", "pa-scan-2"), detail.scans.map { it.id })
        val unboxedScan = detail.scans[0]
        assertEquals("pa-item-1", unboxedScan.receivingInvoiceItemId)
        assertEquals(4, unboxedScan.qty)
        assertEquals("DC1", unboxedScan.dateCode)
        assertEquals("LOT1", unboxedScan.lotCode)
        assertEquals("CN", unboxedScan.coo)
        assertEquals("TW", unboxedScan.cow)
        assertNull(unboxedScan.shelfBoxId)
        assertEquals("pa-box-1", detail.scans[1].shelfBoxId)
        assertEquals(3, detail.scans[1].qty)

        assertEquals(1, detail.boxes.size)
        val box = detail.boxes.single()
        assertEquals("pa-box-1", box.id)
        assertEquals("A-01-01", box.shelfCode)
        assertEquals("A", box.zone)
        assertEquals("open", box.status)
        assertEquals(1783779245783L, box.createdAt)
        assertEquals(1, box.lineCount)
        assertEquals(3, box.totalQty)
        assertEquals(listOf(PutAwayBoxContent("PA-PART-1", 3)), box.contents)

        assertEquals(listOf(ShelfOption("A-01-01", "A")), detail.shelves)
    }

    @Test
    fun `lots are empty when order is clear`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "clear")
        insertPart(db, "pa-part-1", "PA-PART-1")
        fixture { wdb ->
            insertReceivingInvoice(wdb, "pa-inv-1", "pa-order-1")
            insertReceivingInvoiceItem(wdb, "pa-item-1", "pa-inv-1", "pa-part-1", qty = 10)
            insertShelfBox(wdb, "pa-box-1", "pa-order-1", null)
            insertPutAwayScan(wdb, "pa-scan-1", itemId = "pa-item-1", partId = "pa-part-1", qty = 4)
            insertPutAwayScan(
                wdb, "pa-scan-2", itemId = "pa-item-1", partId = "pa-part-1", qty = 3,
                shelfBoxId = "pa-box-1",
            )
        }

        val detail = repo.getPutAwayDetail("pa-order-1") ?: error("expected detail")

        assertEquals("clear", detail.header.status)
        // Web parity: the lots panel shows common_no_lots unless the order is in_hand.
        assertTrue(detail.lots.isEmpty())
        assertEquals(2, detail.scans.size)
        assertEquals(1, detail.boxes.size)
    }

    @Test
    fun `lot with only unboxed scans is kept`() = runBlocking {
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

        val detail = repo.getPutAwayDetail("pa-order-1") ?: error("expected detail")

        assertEquals(1, detail.lots.size)
        val lot = detail.lots.single()
        assertEquals("pa-item-1", lot.receivingInvoiceItemId)
        assertEquals(0, lot.availableQty)
        assertEquals(10, lot.scannedQty)
        assertEquals(0, lot.boxedQty)
    }

    @Test
    fun `box ordering is open first then newest first`() = runBlocking {
        insertReceivingOrder(db, "pa-order-1", "PA-001", "in_hand")
        fixture { wdb ->
            insertShelfBox(wdb, "pa-box-closed-old", "pa-order-1", null, status = "closed", createdAt = 1000)
            insertShelfBox(wdb, "pa-box-closed-new", "pa-order-1", null, status = "closed", createdAt = 2000)
            insertShelfBox(wdb, "pa-box-open", "pa-order-1", null, status = "open", createdAt = 500)
        }

        val detail = repo.getPutAwayDetail("pa-order-1") ?: error("expected detail")

        assertEquals(
            listOf("pa-box-open", "pa-box-closed-new", "pa-box-closed-old"),
            detail.boxes.map { it.id },
        )
    }

    /** Batches raw fixture inserts in one off-main-thread block (Room forbids main-thread writes). */
    private fun fixture(block: (SupportSQLiteDatabase) -> Unit) = offMainThread {
        block(db.openHelper.writableDatabase)
    }
}
