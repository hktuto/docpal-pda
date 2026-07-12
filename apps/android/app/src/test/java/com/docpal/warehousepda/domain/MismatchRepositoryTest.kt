package com.docpal.warehousepda.domain

import android.content.Context
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.ReceivingRepository
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.data.db.ReceivingInvoiceItemEntity
import com.docpal.warehousepda.data.db.ReceivingItemMismatchEntity
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MismatchRepositoryTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: MismatchRepository
    private lateinit var receivingRepo: ReceivingRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        receivingRepo = ReceivingRepository(db)
        repo = MismatchRepository(db, receivingRepo)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `report applies effective received qty and logs against item id`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "damaged", 40, null, "box crushed")
        val after = itemById(item.id)
        assertEquals(item.qty - 40, after.receivedQty)
        val mismatch = activeMismatch(item.id)!!
        assertEquals("pending", mismatch.status)
        assertEquals(item.receivedQty, mismatch.previousReceivedQty)
        assertEquals(item.qty - 40, mismatch.effectiveReceivedQty)
        val log = latestLog("receiving_item_mismatch", item.id)!!
        assertEquals("pending", log.toState)
        assertEquals(ACTOR_A, log.actorId)
    }

    @Test
    fun `report rejects second pending mismatch`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "damaged", 1, null, "")
        val e = assertThrows(LocalizedException::class.java) {
            runBlocking { repo.reportMismatch(item.id, ACTOR_A, "damaged", 2, null, "") }
        }
        assertEquals("pending_mismatch_already_exists", e.code)
    }

    @Test
    fun `four eyes - reporter cannot confirm or cancel own mismatch`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "qty_mismatch", 5, null, "")
        val m = activeMismatch(item.id)!!
        assertEquals(
            "reporter_cannot_confirm_own_mismatch",
            assertThrows(LocalizedException::class.java) {
                runBlocking { repo.confirmMismatch(m.id, ACTOR_A) }
            }.code,
        )
        assertEquals(
            "reporter_cannot_cancel_own_mismatch",
            assertThrows(LocalizedException::class.java) {
                runBlocking { repo.cancelMismatch(m.id, ACTOR_A) }
            }.code,
        )
    }

    @Test
    fun `cancel reverts received qty to snapshot`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "not_found", null, null, "missing")
        assertEquals(0, itemById(item.id).receivedQty)
        val m = activeMismatch(item.id)!!
        repo.cancelMismatch(m.id, ACTOR_B)
        assertEquals(item.receivedQty, itemById(item.id).receivedQty)
        assertNull(activeMismatch(item.id))
    }

    @Test
    fun `confirm blocks further reports`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "damaged", 1, null, "")
        val m = activeMismatch(item.id)!!
        repo.confirmMismatch(m.id, ACTOR_B)
        assertEquals(
            "confirmed_mismatch_already_exists",
            assertThrows(LocalizedException::class.java) {
                runBlocking { repo.reportMismatch(item.id, ACTOR_B, "damaged", 1, null, "") }
            }.code,
        )
    }

    @Test
    fun `edit by non reporter rejected, edit recomputes effective qty`() = runBlocking {
        val item = firstSeededPendingItem()
        repo.reportMismatch(item.id, ACTOR_A, "damaged", 10, null, "")
        val m = activeMismatch(item.id)!!
        assertEquals(
            "only_reporter_can_edit_mismatch",
            assertThrows(LocalizedException::class.java) {
                runBlocking { repo.editMismatch(m.id, ACTOR_B, "damaged", 20, null, "") }
            }.code,
        )
        repo.editMismatch(m.id, ACTOR_A, "qty_mismatch", 7, null, "recounted")
        assertEquals(7, itemById(item.id).receivedQty)
        assertEquals("qty_mismatch", activeMismatch(item.id)!!.reason)
    }

    @Test
    fun `mismatch that would drop below consumed stock is rejected`() = runBlocking {
        // Fresh in_hand order with an item that has picked_qty = 6 (consumed).
        // Reporting qty_mismatch with received 5 < 6 must be rejected.
        offMainThread {
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_orders (id, ref_no, supplier_id, delivery_date, status, arrived_at, arrived_by, created_at, updated_at) " +
                    "VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TEST-CONSUMED-01', NULL, 1783612800000, 'in_hand', NULL, NULL, 1783779245783, 1783779245783)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id) " +
                    "VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TEST-CONSUMED-01-W-01', NULL)"
            )
            db.openHelper.writableDatabase.execSQL(
                "INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, po_no, po_line, qty, received_qty, picked_qty, put_away_qty, box_id, date_code, lot_code, coo, cow) " +
                    "VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cd426b37-aac4-4e4d-a979-c20738741e65', NULL, NULL, 100, 100, 6, 0, NULL, NULL, NULL, NULL, NULL)"
            )
        }
        val e = assertThrows(LocalizedException::class.java) {
            runBlocking {
                repo.reportMismatch("cccccccc-cccc-cccc-cccc-cccccccccccc", ACTOR_A, "qty_mismatch", 5, null, "")
            }
        }
        assertEquals("mismatch_qty_below_consumed_stock", e.code)
    }

    // The seed ships no pending receiving order, and mismatch operations do not
    // depend on order status (verified in apps/web/db/mismatch.ts). Insert a
    // fresh pending order + invoice + item per test (db is rebuilt in setUp).
    private fun firstSeededPendingItem(): ReceivingInvoiceItemEntity {
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
                    "VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'cd426b37-aac4-4e4d-a979-c20738741e65', NULL, NULL, 100, 100, 0, 0, NULL, NULL, NULL, NULL, NULL)"
            )
        }
        return itemById("33333333-3333-3333-3333-333333333333")
    }

    private fun itemById(id: String): ReceivingInvoiceItemEntity = offMainThread {
        db.receivingDao().itemById(id)!!
    }

    private fun activeMismatch(itemId: String): ReceivingItemMismatchEntity? = offMainThread {
        db.receivingDao().activeMismatchForItem(itemId)
    }

    private fun latestLog(entityType: String, entityId: String): LogRow? = offMainThread {
        db.query(
            SimpleSQLiteQuery(
                "SELECT to_state, actor_id, metadata FROM transition_logs " +
                    "WHERE entity_type = '$entityType' AND entity_id = '$entityId' " +
                    "ORDER BY created_at DESC, rowid DESC LIMIT 1"
            )
        ).use { c ->
            if (c.moveToFirst()) LogRow(c.getString(0), c.getString(1), c.getString(2)) else null
        }
    }

    private data class LogRow(val toState: String, val actorId: String?, val metadata: String?)

    companion object {
        // Two distinct seeded users (see seed.sql INSERT INTO users).
        private const val ACTOR_A = "2f1b9170-11b8-40a0-b21d-bd5dc3ba421d" // operator
        private const val ACTOR_B = "3ac627fe-f897-4e1f-8625-049d6d362f07" // admin
    }
}
