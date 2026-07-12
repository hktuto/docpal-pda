package com.docpal.warehousepda.domain

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Goods-verify read model: shelf list, box summaries, box detail (web
 * apps/web/db/goodsVerify.ts getShelvesWithBoxes / getShelfBoxesByShelf /
 * getShelfBoxDetail). Synthetic fixtures only — setUp wipes the seed import.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GoodsVerifyReadTest {

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
    fun `shelves list includes zero-box shelves with counts`() = runBlocking {
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelf(wdb, "B-01-01", null)
            insertShelfBox(wdb, "gv-box-1", "gv-order-1", "A-01-01")
        }

        val shelves = repo.listShelves()

        assertEquals(2, shelves.size)
        assertEquals("A-01-01", shelves[0].code)
        assertEquals("A", shelves[0].zone)
        assertEquals(1, shelves[0].boxCount)
        assertEquals("B-01-01", shelves[1].code)
        assertNull(shelves[1].zone)
        assertEquals(0, shelves[1].boxCount)
    }

    @Test
    fun `box summaries aggregate per part`() = runBlocking {
        val now = System.currentTimeMillis()
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelfBox(wdb, "gv-box-1", "gv-order-1", "A-01-01")
            // Part X: 2 scans, both verified now. Part Y: 1 scan, unverified.
            insertPutAwayScan(
                wdb, "gv-scan-1", itemId = "gv-item-1", partId = "gv-part-1", qty = 2,
                shelfBoxId = "gv-box-1", verified = 1, verifiedAt = now,
            )
            insertPutAwayScan(
                wdb, "gv-scan-2", itemId = "gv-item-1", partId = "gv-part-1", qty = 3,
                shelfBoxId = "gv-box-1", verified = 1, verifiedAt = now,
            )
            insertPutAwayScan(
                wdb, "gv-scan-3", itemId = "gv-item-2", partId = "gv-part-2", qty = 1,
                shelfBoxId = "gv-box-1",
            )
        }

        val box = repo.listBoxes("A-01-01").single()

        assertEquals("gv-box-1", box.id)
        assertEquals("open", box.status)
        assertEquals(2, box.itemCount)
        assertEquals(1, box.verifiedCount)
        assertEquals(now, box.lastCheckAt)
        assertTrue(box.checkedToday)
    }

    @Test
    fun `checkedToday false for older checks`() = runBlocking {
        val old = System.currentTimeMillis() - 2 * 86_400_000
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelfBox(wdb, "gv-box-1", "gv-order-1", "A-01-01")
            insertPutAwayScan(
                wdb, "gv-scan-1", itemId = "gv-item-1", partId = "gv-part-1", qty = 2,
                shelfBoxId = "gv-box-1", verified = 1, verifiedAt = old,
            )
        }

        val box = repo.listBoxes("A-01-01").single()

        assertEquals(1, box.itemCount)
        assertEquals(1, box.verifiedCount)
        assertEquals(old, box.lastCheckAt)
        assertFalse(box.checkedToday)
    }

    @Test
    fun `box detail groups scans by part`() = runBlocking {
        val checkAt = System.currentTimeMillis()
        insertPart(db, "gv-part-1", "GV-PART-1")
        insertPart(db, "gv-part-2", "GV-PART-2")
        fixture { wdb ->
            insertShelf(wdb, "A-01-01", "A")
            insertShelfBox(wdb, "gv-box-1", "gv-order-1", "A-01-01")
            // Insertion order is the opposite of part_no order: only the ORDER BY
            // p.part_no puts part-1 first.
            insertPutAwayScan(
                wdb, "gv-scan-1", itemId = "gv-item-2", partId = "gv-part-2", qty = 1,
                shelfBoxId = "gv-box-1", verified = 1, verifiedAt = checkAt,
            )
            insertPutAwayScan(
                wdb, "gv-scan-2", itemId = "gv-item-1", partId = "gv-part-1", qty = 2,
                shelfBoxId = "gv-box-1", verified = 1, verifiedAt = checkAt,
            )
            insertPutAwayScan(
                wdb, "gv-scan-3", itemId = "gv-item-1", partId = "gv-part-1", qty = 3,
                shelfBoxId = "gv-box-1",
            )
        }

        val detail = repo.getBoxDetail("gv-box-1") ?: error("expected detail")

        assertEquals("gv-box-1", detail.id)
        assertEquals("open", detail.status)
        assertEquals("A-01-01", detail.shelfCode)
        assertEquals("A", detail.shelfZone)
        assertEquals(2, detail.items.size)
        val part1 = detail.items[0]
        assertEquals("gv-part-1", part1.partId)
        assertEquals("GV-PART-1", part1.partNo)
        assertEquals(5, part1.qty)          // 2 + 3 over both scans
        assertFalse(part1.verified)         // one scan still unverified
        assertEquals(checkAt, part1.verifiedAt)
        val part2 = detail.items[1]
        assertEquals("gv-part-2", part2.partId)
        assertEquals("GV-PART-2", part2.partNo)
        assertEquals(1, part2.qty)
        assertTrue(part2.verified)
        assertEquals(checkAt, part2.verifiedAt)
        assertFalse(detail.allVerified)
    }

    @Test
    fun `box detail null for unknown box`() = runBlocking {
        assertNull(repo.getBoxDetail("nope"))
    }

    /** Batches raw fixture inserts in one off-main-thread block (Room forbids main-thread writes). */
    private fun fixture(block: (SupportSQLiteDatabase) -> Unit) = offMainThread {
        block(db.openHelper.writableDatabase)
    }
}
