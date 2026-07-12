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
import org.junit.Assert.assertNotEquals
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
 * Tests for [PickingRepository] against the seeded in-memory DB plus an isolated
 * fixture (own receiving order / part / picking order) inserted per test class.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PickingRepositoryTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: PickingRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        repo = PickingRepository(db, ReceivingRepository(db, Allocator(db)))
        insertBaseFixture()
    }

    @After
    fun tearDown() = db.close()

    /** in_hand RO with one invoice item (received 100), PO with one item (qty 20, allocated 5, coarse alloc 5). */
    private fun insertBaseFixture() {
        exec(
            "INSERT INTO parts (id, part_no, internal_code, description, default_coo) " +
                "VALUES ('$PART', 'TEST-PART-01', '', '', 'CN')"
        )
        exec(
            "INSERT INTO receiving_orders (id, ref_no, supplier_id, delivery_date, status, arrived_at, arrived_by, created_at, updated_at) " +
                "VALUES ('$RO', 'TEST-RO-01', NULL, 1783612800000, 'in_hand', 1783779245783, '$ACTOR', 1783779245783, 1783779245783)"
        )
        exec(
            "INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id) " +
                "VALUES ('$INV', '$RO', 'TEST-RO-01-W-01', NULL)"
        )
        exec(
            "INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, po_no, po_line, qty, received_qty, picked_qty, put_away_qty, box_id, date_code, lot_code, coo, cow) " +
                "VALUES ('$INV_ITEM', '$INV', '$PART', NULL, NULL, 100, 100, 0, 0, NULL, NULL, NULL, NULL, NULL)"
        )
        insertPickingOrder(PO, "TEST-PO-01", "pending")
        exec(
            "INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, allocated_qty, required_date_code, source_shelf_code) " +
                "VALUES ('$PI', '$PO', '$PART', 20, 0, 5, NULL, NULL)"
        )
        exec(
            "INSERT INTO allocations (id, picking_item_id, inventory_lot_id, receiving_order_id, qty, remark) " +
                "VALUES ('$ALLOC', '$PI', NULL, '$RO', 5, NULL)"
        )
    }

    private fun insertPickingOrder(id: String, refNo: String, status: String) {
        exec(
            "INSERT INTO picking_orders (id, ref_no, supplier_id, delivery_date, po_no, required_date_code_notice, ship_to, destination_country, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark, issue_reported_at, issue_reported_by, status, created_at, updated_at) " +
                "VALUES ('$id', '$refNo', NULL, 1783872000000, NULL, NULL, 'GZ', 'China', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '$status', 1783779245783, 1783779245783)"
        )
    }

    private fun insertPickingItem(id: String, orderId: String, partId: String, qty: Int, allocated: Int) {
        exec(
            "INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, allocated_qty, required_date_code, source_shelf_code) " +
                "VALUES ('$id', '$orderId', '$partId', $qty, 0, $allocated, NULL, NULL)"
        )
    }

    private fun insertCoarseAllocation(id: String, itemId: String, qty: Int) {
        exec(
            "INSERT INTO allocations (id, picking_item_id, inventory_lot_id, receiving_order_id, qty, remark) " +
                "VALUES ('$id', '$itemId', NULL, '$RO', $qty, NULL)"
        )
    }

    private fun insertReceivingAreaLot(id: String, total: Int, allocated: Int) {
        exec(
            "INSERT INTO inventory_lots (id, part_id, date_code, lot_code, coo, cow, shelf_code, box_id, total_qty, allocated_qty, available_qty) " +
                "VALUES ('$id', '$PART', '2406', 'L1', 'MY', NULL, NULL, NULL, $total, $allocated, ${total - allocated})"
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

    @Test
    fun `applyOcrPick creates package, lot, sources and consumes allocation`() = runBlocking {
        repo.applyOcrPick(RO, PI, qty = 5, dateCode = "2406", lotCode = "L1", coo = "MY", cow = null, actorId = ACTOR)

        // One unboxed package of 5 with the scanned label fields.
        assertEquals(1, intQuery("SELECT COUNT(*) FROM picking_packages WHERE picking_item_id = '$PI'"))
        assertEquals(5, intQuery("SELECT qty FROM picking_packages WHERE picking_item_id = '$PI'"))
        assertEquals(
            "inventory_lot",
            stringQuery("SELECT source_type FROM picking_packages WHERE picking_item_id = '$PI'"),
        )
        assertEquals("2406", stringQuery("SELECT date_code FROM picking_packages WHERE picking_item_id = '$PI'"))
        assertEquals("L1", stringQuery("SELECT lot_code FROM picking_packages WHERE picking_item_id = '$PI'"))
        assertEquals("MY", stringQuery("SELECT coo FROM picking_packages WHERE picking_item_id = '$PI'"))
        assertNull(stringQuery("SELECT shipping_box_id FROM picking_packages WHERE picking_item_id = '$PI'"))

        // Lot created with 5, fully consumed by the scan.
        val lotId = stringQuery("SELECT source_id FROM picking_packages WHERE picking_item_id = '$PI'")!!
        assertEquals(0, intQuery("SELECT total_qty FROM inventory_lots WHERE id = '$lotId'"))
        assertEquals(0, intQuery("SELECT allocated_qty FROM inventory_lots WHERE id = '$lotId'"))
        assertEquals(1, intQuery("SELECT COUNT(*) FROM inventory_lot_sources WHERE inventory_lot_id = '$lotId'"))
        assertEquals(0, intQuery("SELECT qty FROM inventory_lot_sources WHERE inventory_lot_id = '$lotId'"))

        // Invoice item picked via the source walk; item picked_qty untouched until boxed.
        assertEquals(5, intQuery("SELECT picked_qty FROM receiving_invoice_items WHERE id = '$INV_ITEM'"))
        assertEquals(0, intQuery("SELECT picked_qty FROM picking_items WHERE id = '$PI'"))
        // allocated 5 (coarse) -> 0 after scan.
        assertEquals(0, intQuery("SELECT allocated_qty FROM picking_items WHERE id = '$PI'"))
        // Coarse allocation fully consumed -> deleted; lot allocation remains at 0.
        assertEquals(0, intQuery("SELECT COUNT(*) FROM allocations WHERE id = '$ALLOC'"))
        assertEquals(
            0,
            intQuery("SELECT qty FROM allocations WHERE picking_item_id = '$PI' AND inventory_lot_id = '$lotId'"),
        )

        // picking -> scanned transition log referencing the package.
        val metadata = stringQuery(
            "SELECT metadata FROM transition_logs " +
                "WHERE entity_type = 'picking_item' AND entity_id = '$PI' AND from_state = 'picking' AND to_state = 'scanned'"
        )
        assertNotNull(metadata)
        val packageId = stringQuery("SELECT id FROM picking_packages WHERE picking_item_id = '$PI'")!!
        assertTrue(metadata!!.contains(packageId))
    }

    @Test
    fun `applyOcrPick rejects qty above remaining and above availability`() = runBlocking {
        // remaining = 20 - 0 - 0 = 20 -> 21 exceeds the picking need.
        expectCode("quantity_exceeds_picking_need") {
            repo.applyOcrPick(RO, PI, 21, null, null, null, null, ACTOR)
        }

        // Another picking item reserves 95 of the 100 physical -> only 5 available for this scan.
        insertPickingOrder(PO2, "TEST-PO-02", "pending")
        insertPickingItem(PI2, PO2, PART, qty = 100, allocated = 95)
        insertCoarseAllocation(ALLOC2, PI2, 95)
        expectCode("quantity_not_available_receiving") {
            repo.applyOcrPick(RO, PI, 10, null, null, null, null, ACTOR)
        }
    }

    @Test
    fun `applyOcrPick rejects wrong part and non in_hand order`() = runBlocking {
        // Picking item whose part never appears in the receiving order.
        exec(
            "INSERT INTO parts (id, part_no, internal_code, description, default_coo) " +
                "VALUES ('$PART_OTHER', 'TEST-PART-02', '', '', 'CN')"
        )
        insertPickingItem(PI_OTHER, PO, PART_OTHER, qty = 10, allocated = 0)
        expectCode("receiving_picking_part_mismatch") {
            repo.applyOcrPick(RO, PI_OTHER, 5, null, null, null, null, ACTOR)
        }

        // Receiving order not in_hand.
        exec(
            "INSERT INTO receiving_orders (id, ref_no, supplier_id, delivery_date, status, arrived_at, arrived_by, created_at, updated_at) " +
                "VALUES ('$RO_PENDING', 'TEST-RO-02', NULL, 1783612800000, 'pending', NULL, NULL, 1783779245783, 1783779245783)"
        )
        expectCode("receiving_order_not_in_hand") {
            repo.applyOcrPick(RO_PENDING, PI, 5, null, null, null, null, ACTOR)
        }
    }

    @Test
    fun `applyOcrPick tops up coarse allocation when scan exceeds existing`() = runBlocking {
        // Existing coarse allocation 5, scan 10 -> a second coarse allocation of 5 is
        // inserted, both are consumed, and a single package of 10 is created.
        repo.applyOcrPick(RO, PI, qty = 10, dateCode = "2406", lotCode = "L1", coo = "MY", cow = null, actorId = ACTOR)

        assertEquals(1, intQuery("SELECT COUNT(*) FROM picking_packages WHERE picking_item_id = '$PI'"))
        assertEquals(10, intQuery("SELECT qty FROM picking_packages WHERE picking_item_id = '$PI'"))
        // Both coarse allocations consumed and deleted.
        assertEquals(
            0,
            intQuery("SELECT COUNT(*) FROM allocations WHERE picking_item_id = '$PI' AND receiving_order_id = '$RO'"),
        )
        // allocated: 5 + 5 (top-up) - 10 (scan) = 0.
        assertEquals(0, intQuery("SELECT allocated_qty FROM picking_items WHERE id = '$PI'"))
        assertEquals(10, intQuery("SELECT picked_qty FROM receiving_invoice_items WHERE id = '$INV_ITEM'"))
    }

    @Test
    fun `addPackageToBox increments picked qty and remove reverts it`() = runBlocking {
        repo.applyOcrPick(RO, PI, 5, "2406", "L1", "MY", null, ACTOR)
        val packageId = stringQuery("SELECT id FROM picking_packages WHERE picking_item_id = '$PI'")!!
        val boxId = repo.createShippingBoxForPickingOrder(PO, ACTOR)

        repo.addPackageToBox(packageId, boxId, ACTOR)
        assertEquals(5, intQuery("SELECT picked_qty FROM picking_items WHERE id = '$PI'"))
        assertEquals(boxId, stringQuery("SELECT shipping_box_id FROM picking_packages WHERE id = '$packageId'"))
        assertNotNull(
            stringQuery(
                "SELECT id FROM transition_logs " +
                    "WHERE entity_type = 'picking_item' AND entity_id = '$PI' AND from_state = 'scanned' AND to_state = 'boxed'"
            )
        )
        // Not all 20 picked -> order not auto-finished.
        assertEquals("pending", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO'"))

        repo.removePackageFromBox(packageId, ACTOR)
        assertEquals(0, intQuery("SELECT picked_qty FROM picking_items WHERE id = '$PI'"))
        assertNull(stringQuery("SELECT shipping_box_id FROM picking_packages WHERE id = '$packageId'"))
        assertEquals(0, intQuery("SELECT verified FROM picking_packages WHERE id = '$packageId'"))
        assertNotNull(
            stringQuery(
                "SELECT id FROM transition_logs " +
                    "WHERE entity_type = 'picking_item' AND entity_id = '$PI' AND from_state = 'boxed' AND to_state = 'scanned'"
            )
        )
    }

    @Test
    fun `addAllUnboxedPackagesToBox boxes everything and auto-finishes order`() = runBlocking {
        // Single-item order whose only item becomes fully boxed.
        insertPickingOrder(PO2, "TEST-PO-02", "pending")
        insertPickingItem(PI2, PO2, PART, qty = 5, allocated = 5)
        insertCoarseAllocation(ALLOC2, PI2, 5)

        repo.applyOcrPick(RO, PI2, 5, "2406", "L1", "MY", null, ACTOR)
        val boxId = repo.createShippingBoxForPickingOrder(PO2, ACTOR)

        val count = repo.addAllUnboxedPackagesToBox(boxId, ACTOR)
        assertEquals(1, count)

        assertEquals("finished", stringQuery("SELECT status FROM picking_orders WHERE id = '$PO2'"))
        assertEquals(5, intQuery("SELECT picked_qty FROM picking_items WHERE id = '$PI2'"))
        // Measuring task created and linked to the order's boxes.
        val taskId = stringQuery("SELECT id FROM measuring_tasks WHERE picking_order_id = '$PO2'")
        assertNotNull(taskId)
        assertEquals("pending", stringQuery("SELECT status FROM measuring_tasks WHERE picking_order_id = '$PO2'"))
        assertEquals(taskId, stringQuery("SELECT measuring_task_id FROM shipping_boxes WHERE id = '$boxId'"))
        // Auto-finish transition log.
        val metadata = stringQuery(
            "SELECT metadata FROM transition_logs " +
                "WHERE entity_type = 'picking_order' AND entity_id = '$PO2' AND to_state = 'finished'"
        )
        assertNotNull(metadata)
        assertTrue(metadata!!.contains("auto"))
    }

    @Test
    fun `removeScannedPackage reverses scan and restores allocation`() = runBlocking {
        repo.applyOcrPick(RO, PI, 5, "2406", "L1", "MY", null, ACTOR)
        val packageId = stringQuery("SELECT id FROM picking_packages WHERE picking_item_id = '$PI'")!!
        val lotId = stringQuery("SELECT source_id FROM picking_packages WHERE id = '$packageId'")!!

        repo.removeScannedPackage(packageId, ACTOR)

        assertEquals(0, intQuery("SELECT COUNT(*) FROM picking_packages WHERE id = '$packageId'"))
        // Invoice item picked_qty restored.
        assertEquals(0, intQuery("SELECT picked_qty FROM receiving_invoice_items WHERE id = '$INV_ITEM'"))
        // Lot and its source restored.
        assertEquals(5, intQuery("SELECT total_qty FROM inventory_lots WHERE id = '$lotId'"))
        assertEquals(5, intQuery("SELECT allocated_qty FROM inventory_lots WHERE id = '$lotId'"))
        assertEquals(5, intQuery("SELECT qty FROM inventory_lot_sources WHERE inventory_lot_id = '$lotId'"))
        // Lot allocation restored to 5; item allocated_qty restored to 5.
        assertEquals(
            5,
            intQuery("SELECT qty FROM allocations WHERE picking_item_id = '$PI' AND inventory_lot_id = '$lotId'"),
        )
        assertEquals(5, intQuery("SELECT allocated_qty FROM picking_items WHERE id = '$PI'"))
        assertEquals(0, intQuery("SELECT picked_qty FROM picking_items WHERE id = '$PI'"))
        // scanned -> removed transition log.
        assertNotNull(
            stringQuery(
                "SELECT id FROM transition_logs " +
                    "WHERE entity_type = 'picking_item' AND entity_id = '$PI' AND from_state = 'scanned' AND to_state = 'removed'"
            )
        )
        // Receiving order stays in_hand (item available again).
        assertEquals("in_hand", stringQuery("SELECT status FROM receiving_orders WHERE id = '$RO'"))
    }

    @Test
    fun `createShippingBox generates sequential BOX-HK1 ids`() = runBlocking {
        insertPickingOrder(PO2, "TEST-PO-02", "pending")
        val first = repo.createShippingBoxForPickingOrder(PO, ACTOR)
        val second = repo.createShippingBoxForPickingOrder(PO2, ACTOR)

        val pattern = Regex("^BOX-HK1-\\d{4}(\\d{6})$")
        val firstMatch = pattern.matchEntire(first)
        val secondMatch = pattern.matchEntire(second)
        assertNotNull("first box id '$first' has unexpected shape", firstMatch)
        assertNotNull("second box id '$second' has unexpected shape", secondMatch)
        assertEquals("000001", firstMatch!!.groupValues[1])
        assertEquals("000002", secondMatch!!.groupValues[1])
        // Same ISO week + year prefix.
        assertEquals(first.dropLast(6), second.dropLast(6))
    }

    @Test
    fun `validation errors match web keys`() = runBlocking {
        // box_is_not_open: package into a cancelled box.
        insertPackage(PKG1, PI, PO, qty = 5, boxId = null)
        insertBox(BOX1, PO, "cancelled")
        expectCode("box_is_not_open") { repo.addPackageToBox(PKG1, BOX1, ACTOR) }

        // package_already_in_box: checked before the box is even loaded.
        insertPackage(PKG2, PI, PO, qty = 5, boxId = BOX1)
        expectCode("package_already_in_box") { repo.addPackageToBox(PKG2, BOX1, ACTOR) }

        // package_does_not_belong_to_picking_order: open box of another order.
        insertPickingOrder(PO2, "TEST-PO-02", "pending")
        insertBox(BOX2, PO2, "open")
        expectCode("package_does_not_belong_to_picking_order") { repo.addPackageToBox(PKG1, BOX2, ACTOR) }

        // picking_order_has_open_issue: box of an order in issue status.
        insertPickingOrder(PO_ISSUE, "TEST-PO-03", "issue")
        insertPickingItem(PI_ISSUE, PO_ISSUE, PART, qty = 10, allocated = 0)
        insertPackage(PKG3, PI_ISSUE, PO_ISSUE, qty = 5, boxId = null)
        insertBox(BOX3, PO_ISSUE, "open")
        expectCode("picking_order_has_open_issue") { repo.addPackageToBox(PKG3, BOX3, ACTOR) }

        // scan_quantity_exceeds_required: scanning more than the item requires.
        insertReceivingAreaLot(LOT1, total = 21, allocated = 21)
        exec(
            "INSERT INTO allocations (id, picking_item_id, inventory_lot_id, receiving_order_id, qty, remark) " +
                "VALUES ('$ALLOC_LOT', '$PI', '$LOT1', NULL, 21, NULL)"
        )
        expectCode("scan_quantity_exceeds_required") {
            repo.scanAllocationToPackage(ALLOC_LOT, 21, ACTOR)
        }
    }

    @Test
    fun `materializeReceivingAllocation converts coarse allocation into lot and sources`() = runBlocking {
        // Full materialization: allocation keeps its id and moves to the new lot.
        val returnedId = repo.materializeReceivingAllocation(
            ALLOC, 5, "2406", "L2", "MY", null, INV_ITEM,
        )
        assertEquals(ALLOC, returnedId)
        assertNull(stringQuery("SELECT receiving_order_id FROM allocations WHERE id = '$ALLOC'"))
        val lotId = stringQuery("SELECT inventory_lot_id FROM allocations WHERE id = '$ALLOC'")
        assertNotNull(lotId)
        assertEquals(5, intQuery("SELECT total_qty FROM inventory_lots WHERE id = '$lotId'"))
        assertEquals(5, intQuery("SELECT allocated_qty FROM inventory_lots WHERE id = '$lotId'"))
        assertEquals(5, intQuery("SELECT qty FROM inventory_lot_sources WHERE inventory_lot_id = '$lotId'"))
        assertEquals(
            INV_ITEM,
            stringQuery("SELECT receiving_invoice_item_id FROM inventory_lot_sources WHERE inventory_lot_id = '$lotId'"),
        )
        // Item allocated_qty untouched by materialization.
        assertEquals(5, intQuery("SELECT allocated_qty FROM picking_items WHERE id = '$PI'"))
        // Invoice item picked_qty untouched (no scan happened).
        assertEquals(0, intQuery("SELECT picked_qty FROM receiving_invoice_items WHERE id = '$INV_ITEM'"))

        // Partial materialization: original reduced, new lot allocation created.
        insertCoarseAllocation(ALLOC2, PI, 10)
        val newId = repo.materializeReceivingAllocation(ALLOC2, 4, null, null, null, null, INV_ITEM)
        assertNotEquals(ALLOC2, newId)
        assertEquals(6, intQuery("SELECT qty FROM allocations WHERE id = '$ALLOC2'"))
        assertEquals(RO, stringQuery("SELECT receiving_order_id FROM allocations WHERE id = '$ALLOC2'"))
        assertEquals(4, intQuery("SELECT qty FROM allocations WHERE id = '$newId'"))
        assertNotNull(stringQuery("SELECT inventory_lot_id FROM allocations WHERE id = '$newId'"))

        // Error keys.
        expectCode("allocation_not_found") {
            repo.materializeReceivingAllocation("no-such-id", 1, null, null, null, null, INV_ITEM)
        }
        expectCode("invalid_materialize_quantity") {
            repo.materializeReceivingAllocation(ALLOC2, 0, null, null, null, null, INV_ITEM)
        }
        expectCode("invalid_materialize_quantity") {
            repo.materializeReceivingAllocation(ALLOC2, 7, null, null, null, null, INV_ITEM)
        }
        expectCode("receiving_invoice_item_not_found") {
            repo.materializeReceivingAllocation(ALLOC2, 1, null, null, null, null, "no-such-item")
        }
        // A lot allocation (no receiving order) cannot be materialized again.
        expectCode("allocation_not_against_receiving_order") {
            repo.materializeReceivingAllocation(newId, 1, null, null, null, null, INV_ITEM)
        }
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
        // Seeded operator user.
        private const val ACTOR = "2f1b9170-11b8-40a0-b21d-bd5dc3ba421d"

        private const val RO = "aaaa0000-0000-0000-0000-000000000001"
        private const val RO_PENDING = "aaaa0000-0000-0000-0000-000000000002"
        private const val PART = "bbbb0000-0000-0000-0000-000000000001"
        private const val PART_OTHER = "bbbb0000-0000-0000-0000-000000000002"
        private const val INV = "cccc0000-0000-0000-0000-000000000001"
        private const val INV_ITEM = "dddd0000-0000-0000-0000-000000000001"
        private const val PO = "eeee0000-0000-0000-0000-000000000001"
        private const val PO2 = "eeee0000-0000-0000-0000-000000000002"
        private const val PO_ISSUE = "eeee0000-0000-0000-0000-000000000003"
        private const val PI = "ffff0000-0000-0000-0000-000000000001"
        private const val PI2 = "ffff0000-0000-0000-0000-000000000002"
        private const val PI_OTHER = "ffff0000-0000-0000-0000-000000000003"
        private const val PI_ISSUE = "ffff0000-0000-0000-0000-000000000004"
        private const val ALLOC = "11110000-0000-0000-0000-000000000001"
        private const val ALLOC2 = "11110000-0000-0000-0000-000000000002"
        private const val ALLOC_LOT = "11110000-0000-0000-0000-000000000003"
        private const val LOT1 = "22220000-0000-0000-0000-000000000001"
        private const val PKG1 = "33330000-0000-0000-0000-000000000001"
        private const val PKG2 = "33330000-0000-0000-0000-000000000002"
        private const val PKG3 = "33330000-0000-0000-0000-000000000003"
        private const val BOX1 = "44440000-0000-0000-0000-000000000001"
        private const val BOX2 = "44440000-0000-0000-0000-000000000002"
        private const val BOX3 = "44440000-0000-0000-0000-000000000003"
    }
}
