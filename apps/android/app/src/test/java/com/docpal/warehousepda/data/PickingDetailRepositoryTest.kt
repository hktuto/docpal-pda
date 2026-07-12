package com.docpal.warehousepda.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.Allocator
import com.docpal.warehousepda.domain.PickingRepository
import com.docpal.warehousepda.domain.exec
import com.docpal.warehousepda.domain.insertAllocation
import com.docpal.warehousepda.domain.insertBox
import com.docpal.warehousepda.domain.insertInventoryLot
import com.docpal.warehousepda.domain.insertPackage
import com.docpal.warehousepda.domain.insertPart
import com.docpal.warehousepda.domain.insertPickingItem
import com.docpal.warehousepda.domain.insertPickingOrder
import com.docpal.warehousepda.domain.insertReceivingOrder
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
 * Read-model tests for [PickingRepository.getPickingOrderDetail] and
 * [PickingRepository.pickingItemLogs]: a synthetic deterministic-id fixture
 * (own supplier / part / receiving order / picking order) on top of the seeded
 * in-memory DB, mirroring PickingRepositoryTest.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PickingDetailRepositoryTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: PickingRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        repo = PickingRepository(db, ReceivingRepository(db, Allocator(db)))
        insertDetailFixture()
    }

    @After
    fun tearDown() = db.close()

    /**
     * po-1 (supplier KOA, measuring task mt-1) with one item pi-1 (qty 20, picked 10):
     * lot allocation alloc-lot (qty 5, lot on SHELF-1) + RO allocation alloc-ro
     * (qty 10, remark box ids), unboxed package pkg-1 (3) + boxed package pkg-2
     * (10) in open box box-1.
     */
    private fun insertDetailFixture() {
        exec(
            db,
            "INSERT INTO suppliers (id, code, name, qrcode_template, qrcode_qty_encoding) " +
                "VALUES ('$SUPPLIER', 'KOA-T', 'KOA', NULL, NULL)"
        )
        insertPart(db, PART, "TEST-PART-01")
        insertReceivingOrder(db, RO, "TEST-RO-01", "in_hand")
        insertPickingOrder(db, PO, "TEST-PO-01", "picking", supplierId = SUPPLIER)
        insertPickingItem(db, PI, PO, PART, 20, pickedQty = 10)
        exec(
            db,
            "INSERT INTO measuring_tasks (id, picking_order_id, status, created_at) " +
                "VALUES ('$MEASURING_TASK', '$PO', 'pending', 1783779245783)"
        )
        insertInventoryLot(
            db, LOT, PART, total = 5, allocated = 5,
            shelfCode = "SHELF-1", dateCode = "2406", lotCode = "L1", coo = "MY",
        )
        insertAllocation(db, ALLOC_LOT, PI, lotId = LOT, qty = 5)
        insertAllocation(db, ALLOC_RO, PI, receivingOrderId = RO, qty = 10, remark = "[\"BOX-A\",\"BOX-B\"]")
        insertPackage(db, PKG_UNBOXED, PI, PO, 3, null)
        insertPackage(db, PKG_BOXED, PI, PO, 10, BOX)
        insertBox(db, BOX, PO, "open")
    }

    @Test
    fun `detail assembles header items allocations boxes`() = runBlocking {
        val detail = repo.getPickingOrderDetail(PO)!!
        assertEquals(PO, detail.id)
        assertEquals("TEST-PO-01", detail.refNo)
        assertEquals("picking", detail.status)
        assertEquals("KOA", detail.supplierName)
        assertEquals("KOA-T", detail.supplierCode)
        assertEquals(1783872000000L, detail.deliveryDate)
        assertEquals("GZ", detail.shipTo)
        assertEquals(MEASURING_TASK, detail.measuringTaskId)
        assertNull(detail.issueReason)
        assertNull(detail.issueReportedByName)

        val item = detail.items.single()
        assertEquals(PI, item.id)
        assertEquals("TEST-PART-01", item.partNo)
        assertEquals(20, item.qty)
        assertEquals(10, item.pickedQty)          // boxed only
        assertEquals(13, item.scannedQty)         // all packages
        assertEquals(2, item.allocations.size)

        val lotAlloc = item.allocations.first { it.lotId != null }
        assertEquals(LOT, lotAlloc.lotId)
        assertEquals(5, lotAlloc.qty)
        assertEquals("SHELF-1", lotAlloc.shelfCode)
        assertEquals("2406", lotAlloc.dateCode)
        assertEquals("L1", lotAlloc.lotCode)
        assertEquals("MY", lotAlloc.coo)
        assertNull(lotAlloc.receivingOrderId)
        assertTrue(lotAlloc.boxIds.isEmpty())

        val roAlloc = item.allocations.first { it.receivingOrderId != null }
        assertEquals(RO, roAlloc.receivingOrderId)
        assertEquals("TEST-RO-01", roAlloc.receivingOrderRefNo)
        assertEquals(10, roAlloc.qty)
        assertEquals(listOf("BOX-A", "BOX-B"), roAlloc.boxIds)
        assertNull(roAlloc.shelfCode)

        assertEquals(2, item.packages.size)
        val unboxed = item.packages.first { it.shippingBoxId == null }
        assertEquals(PKG_UNBOXED, unboxed.id)
        assertEquals(3, unboxed.qty)

        val box = detail.boxes.single()
        assertEquals(BOX, box.id)
        assertEquals("open", box.status)
        assertEquals(1, box.packageCount)
        assertEquals(10, box.totalQty)
    }

    @Test
    fun `logs grouped by item newest first`() = runBlocking {
        exec(
            db,
            "INSERT INTO users (id, username, password_hash, display_name, role, created_at) " +
                "VALUES ('user-1', 'detail-op', 'x', 'Operator One', 'operator', 1783779245783)"
        )
        insertPickingItem(db, PI2, PO, PART, 5)
        insertLog("log-1", "picking_item", PI, "picking", "scanned", "user-1", "{\"qty\":3}", 1000)
        insertLog("log-2", "picking_item", PI, "scanned", "boxed", null, null, 3000)
        insertLog("log-3", "picking_item", PI2, null, "scanned", "user-1", null, 2000)
        insertLog("log-4", "picking_order", PO, "pending", "picking", "user-1", null, 4000)

        val logs = repo.pickingItemLogs(listOf(PI, PI2))
        assertEquals(setOf(PI, PI2), logs.keys)

        val piLogs = logs[PI]!!
        assertEquals(2, piLogs.size)
        assertEquals("log-2", piLogs[0].id)       // newest first
        assertEquals("log-1", piLogs[1].id)
        assertEquals(3000L, piLogs[0].createdAt)
        assertEquals("boxed", piLogs[0].toState)
        assertNull(piLogs[0].actorName)
        assertEquals("Operator One", piLogs[1].actorName)
        assertEquals("{\"qty\":3}", piLogs[1].metadata)

        val pi2Logs = logs[PI2]!!
        assertEquals(1, pi2Logs.size)
        assertNull(pi2Logs[0].fromState)

        assertTrue(repo.pickingItemLogs(emptyList()).isEmpty())
    }

    @Test
    fun `allocation remark boxIds parse defensively`() = runBlocking {
        insertAllocation(db, "alloc-bad-1", PI, receivingOrderId = RO, qty = 1, remark = "not json")
        insertAllocation(db, "alloc-bad-2", PI, receivingOrderId = RO, qty = 1, remark = "{\"a\":1}")
        insertAllocation(db, "alloc-bad-3", PI, receivingOrderId = RO, qty = 1, remark = "[\"BOX-A\",5]")

        val detail = repo.getPickingOrderDetail(PO)!!
        val byId = detail.items.single().allocations.associateBy { it.id }
        assertEquals(5, byId.size)
        assertEquals(listOf("BOX-A", "BOX-B"), byId[ALLOC_RO]!!.boxIds)
        assertTrue(byId["alloc-bad-1"]!!.boxIds.isEmpty())
        assertTrue(byId["alloc-bad-2"]!!.boxIds.isEmpty())
        assertTrue(byId["alloc-bad-3"]!!.boxIds.isEmpty())
    }

    @Test
    fun `item without allocations or packages is returned with empty lists`() = runBlocking {
        insertPickingItem(db, "pi-empty", PO, PART, 5)

        val detail = repo.getPickingOrderDetail(PO)!!
        assertEquals(2, detail.items.size)
        val empty = detail.items.first { it.id == "pi-empty" }
        assertEquals(5, empty.qty)
        assertEquals(0, empty.scannedQty)
        assertTrue(empty.allocations.isEmpty())
        assertTrue(empty.packages.isEmpty())
    }

    @Test
    fun `order without boxes and with empty box`() = runBlocking {
        insertPickingOrder(db, "po-nobox", "TEST-PO-NB", "picking")
        insertPickingItem(db, "pi-nobox", "po-nobox", PART, 5)

        val noBoxes = repo.getPickingOrderDetail("po-nobox")!!
        assertTrue(noBoxes.boxes.isEmpty())

        insertBox(db, "box-empty", "po-nobox", "open")
        val withEmpty = repo.getPickingOrderDetail("po-nobox")!!
        val box = withEmpty.boxes.single()
        assertEquals("box-empty", box.id)
        assertEquals("open", box.status)
        assertEquals(0, box.packageCount)
        assertEquals(0, box.totalQty)
    }

    @Test
    fun `issue order populates issue header fields`() = runBlocking {
        exec(
            db,
            "INSERT INTO users (id, username, password_hash, display_name, role, created_at) " +
                "VALUES ('user-9', 'issue-op', 'x', 'Issue Reporter', 'operator', 1783779245783)"
        )
        insertPickingOrder(db, "po-issue", "TEST-PO-IS", "issue")
        exec(
            db,
            "UPDATE picking_orders SET issue_reason = 'insufficient_stock', issue_qty = 7, " +
                "issue_pack_size = 3, issue_note = 'only 13 on hand', issue_remark = 'line 2', " +
                "issue_reported_by = 'user-9', issue_reported_at = 1783779245783 WHERE id = 'po-issue'"
        )

        val detail = repo.getPickingOrderDetail("po-issue")!!
        assertEquals("issue", detail.status)
        assertEquals("insufficient_stock", detail.issueReason)
        assertEquals(7, detail.issueQty)
        assertEquals(3, detail.issuePackSize)
        assertEquals("only 13 on hand", detail.issueNote)
        assertEquals("line 2", detail.issueRemark)
        assertEquals("Issue Reporter", detail.issueReportedByName)
    }

    private fun insertLog(
        id: String,
        entityType: String,
        entityId: String,
        fromState: String?,
        toState: String,
        actorId: String?,
        metadata: String?,
        createdAt: Long,
    ) {
        fun q(value: String?) = value?.let { "'$it'" } ?: "NULL"
        exec(
            db,
            "INSERT INTO transition_logs (id, entity_type, entity_id, from_state, to_state, actor_id, metadata, created_at) " +
                "VALUES ('$id', '$entityType', '$entityId', ${q(fromState)}, '$toState', ${q(actorId)}, ${q(metadata)}, $createdAt)"
        )
    }

    companion object {
        private const val SUPPLIER = "sup-1"
        private const val PART = "part-1"
        private const val RO = "ro-1"
        private const val PO = "po-1"
        private const val PI = "pi-1"
        private const val PI2 = "pi-2"
        private const val LOT = "lot-1"
        private const val ALLOC_LOT = "alloc-lot"
        private const val ALLOC_RO = "alloc-ro"
        private const val PKG_UNBOXED = "pkg-1"
        private const val PKG_BOXED = "pkg-2"
        private const val BOX = "box-1"
        private const val MEASURING_TASK = "mt-1"
    }
}
