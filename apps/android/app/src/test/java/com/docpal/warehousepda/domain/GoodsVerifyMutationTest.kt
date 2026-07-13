package com.docpal.warehousepda.domain

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
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
 * Goods-verify mutations: verifyBoxItem + markBoxVerified (web pglite
 * apps/web/db/goodsVerify.ts verifyShelfBoxScans / markShelfBoxVerified).
 * Synthetic fixtures only — setUp wipes the seed import.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GoodsVerifyMutationTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: GoodsVerifyRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        offMainThread { db.clearAllTables() }
        repo = GoodsVerifyRepository(db)
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `verify item sets verified flags and timestamp`() = runBlocking {
        val before = System.currentTimeMillis()
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelfBox(wdb, "gv-box-1", "gv-order-1", "A-01-01")
            // Part X: 2 unverified scans. Part Y: 1 unverified scan (must stay untouched).
            insertPutAwayScan(
                wdb, "gv-scan-1", itemId = "gv-item-1", partId = "gv-part-1", qty = 2,
                shelfBoxId = "gv-box-1",
            )
            insertPutAwayScan(
                wdb, "gv-scan-2", itemId = "gv-item-1", partId = "gv-part-1", qty = 3,
                shelfBoxId = "gv-box-1",
            )
            insertPutAwayScan(
                wdb, "gv-scan-3", itemId = "gv-item-2", partId = "gv-part-2", qty = 1,
                shelfBoxId = "gv-box-1",
            )
        }

        repo.verifyBoxItem("gv-box-1", "gv-part-1")

        // Both part-X rows verified with a fresh timestamp; part-Y row untouched.
        assertEquals(
            2,
            intQuery(
                db,
                "SELECT COUNT(*) FROM put_away_scans WHERE shelf_box_id = 'gv-box-1' " +
                    "AND part_id = 'gv-part-1' AND verified = 1 AND verified_at >= $before"
            )
        )
        assertEquals(
            1,
            intQuery(
                db,
                "SELECT COUNT(*) FROM put_away_scans WHERE shelf_box_id = 'gv-box-1' " +
                    "AND part_id = 'gv-part-2' AND verified = 0 AND verified_at IS NULL"
            )
        )
    }

    @Test
    fun `verify item unknown part throws shelf_box_item_not_found`() = runBlocking {
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelfBox(wdb, "gv-box-1", "gv-order-1", "A-01-01")
            insertPutAwayScan(
                wdb, "gv-scan-1", itemId = "gv-item-1", partId = "gv-part-1", qty = 2,
                shelfBoxId = "gv-box-1",
            )
        }

        expectCode("shelf_box_item_not_found") { repo.verifyBoxItem("gv-box-1", "no-part") }

        // Nothing was touched.
        assertEquals(
            0,
            intQuery(db, "SELECT verified FROM put_away_scans WHERE id = 'gv-scan-1'")
        )
    }

    @Test
    fun `mark verified flips status and logs transition`() = runBlocking {
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelfBox(wdb, "gv-box-1", "gv-order-1", "A-01-01", status = "closed")
            insertPutAwayScan(
                wdb, "gv-scan-1", itemId = "gv-item-1", partId = "gv-part-1", qty = 2,
                shelfBoxId = "gv-box-1", verified = 1, verifiedAt = 1783779245783,
            )
        }

        repo.markBoxVerified("gv-box-1", "actor-1")

        assertEquals(
            "verified",
            stringQuery(db, "SELECT status FROM shelf_boxes WHERE id = 'gv-box-1'")
        )
        assertEquals(1, intQuery(db, "SELECT COUNT(*) FROM transition_logs"))
        assertEquals(
            "shelf_box",
            stringQuery(db, "SELECT entity_type FROM transition_logs WHERE entity_id = 'gv-box-1'")
        )
        assertEquals(
            "closed",
            stringQuery(db, "SELECT from_state FROM transition_logs WHERE entity_id = 'gv-box-1'")
        )
        assertEquals(
            "verified",
            stringQuery(db, "SELECT to_state FROM transition_logs WHERE entity_id = 'gv-box-1'")
        )
        assertEquals(
            "actor-1",
            stringQuery(db, "SELECT actor_id FROM transition_logs WHERE entity_id = 'gv-box-1'")
        )
        assertNull(
            stringQuery(db, "SELECT metadata FROM transition_logs WHERE entity_id = 'gv-box-1'")
        )
    }

    @Test
    fun `mark verified allows open box (pglite parity)`() = runBlocking {
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelfBox(wdb, "gv-box-1", "gv-order-1", "A-01-01")
            insertPutAwayScan(
                wdb, "gv-scan-1", itemId = "gv-item-1", partId = "gv-part-1", qty = 2,
                shelfBoxId = "gv-box-1", verified = 1, verifiedAt = 1783779245783,
            )
        }

        repo.markBoxVerified("gv-box-1", "actor-1")

        assertEquals(
            "verified",
            stringQuery(db, "SELECT status FROM shelf_boxes WHERE id = 'gv-box-1'")
        )
        assertEquals(
            "open",
            stringQuery(db, "SELECT from_state FROM transition_logs WHERE entity_id = 'gv-box-1'")
        )
    }

    @Test
    fun `mark verified rejects unverified scans`() = runBlocking {
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelfBox(wdb, "gv-box-1", "gv-order-1", "A-01-01", status = "closed")
            insertPutAwayScan(
                wdb, "gv-scan-1", itemId = "gv-item-1", partId = "gv-part-1", qty = 2,
                shelfBoxId = "gv-box-1", verified = 1, verifiedAt = 1783779245783,
            )
            insertPutAwayScan(
                wdb, "gv-scan-2", itemId = "gv-item-2", partId = "gv-part-2", qty = 1,
                shelfBoxId = "gv-box-1",
            )
        }

        expectCode("not_all_shelf_box_items_verified") { repo.markBoxVerified("gv-box-1", "actor-1") }

        assertEquals(
            "closed",
            stringQuery(db, "SELECT status FROM shelf_boxes WHERE id = 'gv-box-1'")
        )
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM transition_logs"))
    }

    @Test
    fun `mark verified validation order`() = runBlocking {
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelfBox(wdb, "gv-box-verified", "gv-order-1", "A-01-01", status = "verified")
            insertShelfBox(wdb, "gv-box-empty", "gv-order-1", "A-01-01", status = "closed")
        }

        expectCode("shelf_box_not_found") { repo.markBoxVerified("nope", "actor-1") }
        expectCode("shelf_box_already_verified") { repo.markBoxVerified("gv-box-verified", "actor-1") }
        expectCode("shelf_box_has_no_items") { repo.markBoxVerified("gv-box-empty", "actor-1") }

        // All three rejections happened before any write.
        assertEquals(0, intQuery(db, "SELECT COUNT(*) FROM transition_logs"))
    }

    /** Batches raw fixture inserts in one off-main-thread block (Room forbids main-thread writes). */
    private fun fixture(block: (SupportSQLiteDatabase) -> Unit) = offMainThread {
        block(db.openHelper.writableDatabase)
    }
}
