package com.docpal.warehousepda.domain.scan

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.ScanRepository
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Layer 1: pure matcher tests. Providers are in-memory lambdas, no DB.
 *
 * The first two tests port the receiving cases of
 * apps/web/tests/scanMatchers.test.ts ("findReceivingCandidates empty-field
 * wildcard") with identical fixture data; the in-memory receiving provider
 * mirrors the repository filter (normalized partNo equality + available >= qty),
 * which is where the web's "empty-field wildcard" behavior lives (date/lot/
 * coo/cow are never match filters). The web file's 3 measuring cases and the
 * put-away TODO are skipped — later phases.
 */
class ScanMatcherTest {

    private fun receiving(
        id: String = "rii-1",
        partId: String = "part-1",
        partNo: String = "RK73B1JTTD181G",
        available: Int = 1000,
        dateCode: String? = "",
        lotCode: String? = "",
        coo: String? = "CN",
        cow: String? = "USA",
    ) = ScanMatcher.ReceivingCandidate(
        receivingInvoiceItemId = id, partId = partId, partNo = partNo,
        dateCode = dateCode, lotCode = lotCode, coo = coo, cow = cow,
        availableQty = available,
    )

    private fun picking(
        itemId: String = "pi-1",
        refNo: String = "PICK-001",
        partId: String = "part-1",
        remaining: Int = 1000,
    ) = ScanMatcher.PickingCandidate(
        pickingOrderId = "po-$itemId", pickingOrderRefNo = refNo,
        pickingItemId = itemId, partId = partId, shipTo = "US",
        requiredQty = remaining, pickedQty = 0, remainingQty = remaining,
    )

    private fun matcher(
        receivingRows: List<ScanMatcher.ReceivingCandidate> = listOf(receiving()),
        pickingRows: List<ScanMatcher.PickingCandidate> = listOf(picking()),
    ): ScanMatcher {
        // Mirror ScanRepository.findReceivingCandidates filtering:
        // normalized partNo equality + availableQty >= qty.
        return ScanMatcher(
            receivingCandidates = { _, partNo, qty ->
                receivingRows.filter {
                    ScanPrimitives.normalize(it.partNo) == partNo && it.availableQty >= qty
                }
            },
            pickingCandidates = { _, partId -> pickingRows.filter { it.partId == partId } },
        )
    }

    private fun input(
        partNo: String = "RK73B1JTTD181G",
        qty: String = "100",
        dateCode: String = "",
        lotCode: String = "",
        coo: String = "",
        cow: String = "",
    ) = ScanPrimitives.OcrInput(partNo, dateCode, lotCode, coo, cow, qty)

    private val ctx = ScanMatcher.ReceivingContext(receivingOrderId = "ro-1", pickingItemId = null)

    // --- ported web cases (identical fixture data) ---

    @Test
    fun `matches when the receiving item has empty date lot and the scan provides values`() = runBlocking {
        val result = matcher().matchReceiving(
            ctx,
            input(qty = "100", dateCode = "2544", lotCode = "LOT123", coo = "CN", cow = "USA"),
            actorId = ACTOR,
        )
        assertTrue(result is ScanMatcher.MatchResult.Single)
        val record = (result as ScanMatcher.MatchResult.Single).record
        assertEquals("RK73B1JTTD181G", record.receiving.partNo)
    }

    @Test
    fun `ignores coo cow mismatches when the receiving item provides them`() = runBlocking {
        val result = matcher().matchReceiving(
            ctx,
            input(qty = "100", dateCode = "2544", lotCode = "LOT123", coo = "JP", cow = "USA"),
            actorId = ACTOR,
        )
        assertTrue(result is ScanMatcher.MatchResult.Single)
        assertEquals("RK73B1JTTD181G", (result as ScanMatcher.MatchResult.Single).record.receiving.partNo)
    }

    // --- matcher semantics (web useScanMatchers.matchReceiving) ---

    @Test
    fun `null actor returns operator_not_signed_in`() = runBlocking {
        val result = matcher().matchReceiving(ctx, input(), actorId = null)
        assertEquals(ScanMatcher.MatchResult.Error("operator_not_signed_in"), result)
    }

    @Test
    fun `missing receiving order id returns missing_receiving_order_id`() = runBlocking {
        val result = matcher().matchReceiving(
            ScanMatcher.ReceivingContext(receivingOrderId = null, pickingItemId = null),
            input(),
            actorId = ACTOR,
        )
        assertEquals(ScanMatcher.MatchResult.Error("missing_receiving_order_id"), result)
    }

    @Test
    fun `invalid qty bubbles qty_must_be_positive_integer`() = runBlocking {
        assertEquals(
            ScanMatcher.MatchResult.Error("qty_must_be_positive_integer"),
            matcher().matchReceiving(ctx, input(qty = "0"), actorId = ACTOR),
        )
        assertEquals(
            ScanMatcher.MatchResult.Error("qty_must_be_positive_integer"),
            matcher().matchReceiving(ctx, input(qty = "abc"), actorId = ACTOR),
        )
    }

    @Test
    fun `no receiving candidates returns none`() = runBlocking {
        val result = matcher(receivingRows = emptyList()).matchReceiving(ctx, input(), actorId = ACTOR)
        assertEquals(ScanMatcher.MatchResult.None, result)
    }

    @Test
    fun `qty above available returns none`() = runBlocking {
        val result = matcher(receivingRows = listOf(receiving(available = 50)))
            .matchReceiving(ctx, input(qty = "100"), actorId = ACTOR)
        assertEquals(ScanMatcher.MatchResult.None, result)
    }

    @Test
    fun `under-available first candidate returns none even without provider pre-filtering`() = runBlocking {
        // Exercises the matcher's own defensive qty > availableQty check:
        // the stub returns the candidate regardless of qty.
        val m = ScanMatcher(
            receivingCandidates = { _, _, _ -> listOf(receiving(available = 50)) },
            pickingCandidates = { _, _ -> listOf(picking()) },
        )
        assertEquals(ScanMatcher.MatchResult.None, m.matchReceiving(ctx, input(qty = "100"), actorId = ACTOR))
    }

    @Test
    fun `no picking candidates returns none`() = runBlocking {
        val result = matcher(pickingRows = emptyList()).matchReceiving(ctx, input(), actorId = ACTOR)
        assertEquals(ScanMatcher.MatchResult.None, result)
    }

    @Test
    fun `picking candidate with remaining below qty is filtered`() = runBlocking {
        val result = matcher(pickingRows = listOf(picking(remaining = 50)))
            .matchReceiving(ctx, input(qty = "100"), actorId = ACTOR)
        assertEquals(ScanMatcher.MatchResult.None, result)
    }

    @Test
    fun `one picking candidate returns single`() = runBlocking {
        val result = matcher().matchReceiving(ctx, input(), actorId = ACTOR)
        assertTrue(result is ScanMatcher.MatchResult.Single)
        assertEquals("pi-1", (result as ScanMatcher.MatchResult.Single).record.picking.pickingItemId)
    }

    @Test
    fun `multiple picking candidates return multiple`() = runBlocking {
        val result = matcher(pickingRows = listOf(picking("pi-1"), picking("pi-2")))
            .matchReceiving(ctx, input(), actorId = ACTOR)
        assertTrue(result is ScanMatcher.MatchResult.Multiple)
        assertEquals(2, (result as ScanMatcher.MatchResult.Multiple).records.size)
    }

    @Test
    fun `pinned picking item filters candidates`() = runBlocking {
        val rows = listOf(picking("pi-1"), picking("pi-2"))
        val pinned = ScanMatcher.ReceivingContext(receivingOrderId = "ro-1", pickingItemId = "pi-2")
        val result = matcher(pickingRows = rows).matchReceiving(pinned, input(), actorId = ACTOR)
        assertTrue(result is ScanMatcher.MatchResult.Single)
        assertEquals("pi-2", (result as ScanMatcher.MatchResult.Single).record.picking.pickingItemId)

        val unknownPin = ScanMatcher.ReceivingContext(receivingOrderId = "ro-1", pickingItemId = "pi-9")
        assertEquals(
            ScanMatcher.MatchResult.None,
            matcher(pickingRows = rows).matchReceiving(unknownPin, input(), actorId = ACTOR),
        )
    }

    @Test
    fun `unexpected provider failure returns unknown_match_failed`() = runBlocking {
        val m = ScanMatcher(
            receivingCandidates = { _, _, _ -> throw IllegalStateException("boom") },
            pickingCandidates = { _, _ -> emptyList() },
        )
        assertEquals(ScanMatcher.MatchResult.Error("unknown_match_failed"), m.matchReceiving(ctx, input(), actorId = ACTOR))
    }

    @Test
    fun `cancellation from provider propagates instead of unknown_match_failed`() {
        val m = ScanMatcher(
            receivingCandidates = { _, _, _ -> throw CancellationException("cancelled") },
            pickingCandidates = { _, _ -> emptyList() },
        )
        assertThrows(CancellationException::class.java) {
            runBlocking { m.matchReceiving(ctx, input(), actorId = ACTOR) }
        }
    }

    companion object {
        private const val ACTOR = "2f1b9170-11b8-40a0-b21d-bd5dc3ba421d"
    }
}

/**
 * Layer 2: repository + matcher against the seeded in-memory database.
 * Seed: one in_hand receiving order (ref 04958166) with 73 allocations;
 * no picking packages / put-away scans, so picking remaining = qty - picked_qty > 0.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScanRepositorySeededTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: ScanRepository
    private lateinit var matcher: ScanMatcher

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        repo = ScanRepository(db)
        matcher = ScanMatcher(
            receivingCandidates = repo::findReceivingCandidates,
            pickingCandidates = repo::findPickingCandidates,
        )
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `findReceivingCandidates returns in_hand items with available ge qty, FIFO ordered`() = runBlocking {
        // Two fixture items with distinct date/lot codes on the same part make
        // the ORDER BY date_code, lot_code (normalized) assertion meaningful.
        offMainThread {
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id) " +
                    "VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '$ORDER_ID', 'TEST-SCAN-W-99', NULL)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, po_no, po_line, qty, received_qty, picked_qty, put_away_qty, box_id, date_code, lot_code, coo, cow) " +
                    "VALUES ('ffffffff-ffff-ffff-ffff-fffffffffff1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '$PART_1542F', NULL, NULL, 100, 100, 0, 0, NULL, 'ZZ99', 'LOT-B', NULL, NULL)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, po_no, po_line, qty, received_qty, picked_qty, put_away_qty, box_id, date_code, lot_code, coo, cow) " +
                    "VALUES ('ffffffff-ffff-ffff-ffff-fffffffffff2', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '$PART_1542F', NULL, NULL, 100, 100, 0, 0, NULL, 'AA00', 'LOT-A', NULL, NULL)"
            )
        }
        val candidates = repo.findReceivingCandidates(ORDER_ID, "RK73H1JTTD1542F", qty = 10)
        assertTrue(candidates.isNotEmpty())
        assertTrue(candidates.all { it.availableQty >= 10 })
        // 5000 of the 5000+5000 seeded gross is allocated FIFO to the W-01 item,
        // leaving it at 0 (excluded) and the W-15 item at 5000.
        assertEquals(5000, candidates.first().availableQty)
        // Normalized date codes ordered like web ORDER BY date_code, lot_code
        // (NULLS LAST; 'ZZ99' -> '2299' sorts before 'AA00').
        assertEquals(listOf("", "2299", "AA00"), candidates.map { it.dateCode })
    }

    @Test
    fun `findReceivingCandidates empty for pending order or unknown part`() = runBlocking {
        offMainThread {
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_orders (id, ref_no, supplier_id, delivery_date, status, arrived_at, arrived_by, created_at, updated_at) " +
                    "VALUES ('11111111-1111-1111-1111-111111111111', 'TEST-PENDING-01', NULL, 1783612800000, 'pending', NULL, NULL, 1783779245783, 1783779245783)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id) " +
                    "VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'TEST-PENDING-01-W-01', NULL)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, po_no, po_line, qty, received_qty, picked_qty, put_away_qty, box_id, date_code, lot_code, coo, cow) " +
                    "VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', '$PART_1542F', NULL, NULL, 100, 100, 0, 0, NULL, NULL, NULL, NULL, NULL)"
            )
        }
        // Order not in_hand.
        assertTrue(repo.findReceivingCandidates("11111111-1111-1111-1111-111111111111", "RK73H1JTTD1542F", qty = 10).isEmpty())
        // Unknown part.
        assertTrue(repo.findReceivingCandidates(ORDER_ID, "NO-SUCH-PART", qty = 10).isEmpty())
        // Fully allocated part (gross 410000 = allocated 410000 -> available 0).
        assertTrue(repo.findReceivingCandidates(ORDER_ID, "RK73H1ETTP2001F", qty = 1).isEmpty())
    }

    @Test
    fun `findPickingCandidates excludes finished and orders not linked to this receiving order`() = runBlocking {
        offMainThread {
            // Finished order, linked to the receiving order via an allocation -> excluded by status.
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO picking_orders (id, ref_no, supplier_id, delivery_date, po_no, required_date_code_notice, ship_to, destination_country, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark, issue_reported_at, issue_reported_by, status, created_at, updated_at) " +
                    "VALUES ('f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0', 'ZZ-FINISHED-01', NULL, 1783872000000, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'finished', 1783779245783, 1783779245783)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, allocated_qty, required_date_code, source_shelf_code) " +
                    "VALUES ('f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f1', 'f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0', '$PART_1000F', 1000, 0, 0, NULL, NULL)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO allocations (id, picking_item_id, inventory_lot_id, receiving_order_id, qty, remark) " +
                    "VALUES ('f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f2', 'f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f1', NULL, '$ORDER_ID', 1000, NULL)"
            )
            // Pending order with NO allocation link to the receiving order -> excluded by EXISTS.
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO picking_orders (id, ref_no, supplier_id, delivery_date, po_no, required_date_code_notice, ship_to, destination_country, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark, issue_reported_at, issue_reported_by, status, created_at, updated_at) " +
                    "VALUES ('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1', 'ZZ-UNLINKED-01', NULL, 1783872000000, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pending', 1783779245783, 1783779245783)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, allocated_qty, required_date_code, source_shelf_code) " +
                    "VALUES ('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f2', 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1', '$PART_1000F', 1000, 0, 0, NULL, NULL)"
            )
        }
        val candidates = repo.findPickingCandidates(ORDER_ID, PART_1000F)
        // Only the three seeded linked pending orders survive, ORDER BY po.ref_no.
        assertEquals(
            listOf("GZ-26070045", "GZ-26070052", "SZ-26070044"),
            candidates.map { it.pickingOrderRefNo },
        )
        assertTrue(candidates.all { it.remainingQty > 0 })
    }

    @Test
    fun `matchReceiving end to end - single match`() = runBlocking {
        // Part RK73H1JTTD1542F: available 5000, exactly one linked picking item
        // (SZ-26070048, remaining 5000).
        val result = matcher.matchReceiving(
            ScanMatcher.ReceivingContext(receivingOrderId = ORDER_ID, pickingItemId = null),
            ScanPrimitives.OcrInput(partNo = "RK73H1JTTD1542F", dateCode = "", lotCode = "", coo = "", cow = "", qty = "10"),
            actorId = ACTOR,
        )
        assertTrue(result is ScanMatcher.MatchResult.Single)
        val record = (result as ScanMatcher.MatchResult.Single).record
        assertEquals("a4e61a40-6aad-4007-8374-a224679dceef", record.picking.pickingItemId)
        assertEquals(5000, record.receiving.availableQty)
    }

    @Test
    fun `matchReceiving end to end - multiple matches`() = runBlocking {
        // Part RK73H1ETTP1000F: available 30000, three linked picking items.
        val result = matcher.matchReceiving(
            ScanMatcher.ReceivingContext(receivingOrderId = ORDER_ID, pickingItemId = null),
            ScanPrimitives.OcrInput(partNo = "RK73H1ETTP1000F", dateCode = "", lotCode = "", coo = "", cow = "", qty = "10"),
            actorId = ACTOR,
        )
        assertTrue(result is ScanMatcher.MatchResult.Multiple)
        assertEquals(3, (result as ScanMatcher.MatchResult.Multiple).records.size)
    }

    companion object {
        private const val ORDER_ID = "b55df3d8-bd2a-43d5-80fa-616a7058439a" // seeded in_hand order, ref 04958166
        private const val PART_1542F = "3a3f4d5d-5bc8-4a1c-9da9-56ba7016c603" // RK73H1JTTD1542F
        private const val PART_1000F = "4e0fe5a4-c165-4468-94ac-bf52586feef2" // RK73H1ETTP1000F
        private const val ACTOR = "2f1b9170-11b8-40a0-b21d-bd5dc3ba421d" // seeded operator
    }
}
