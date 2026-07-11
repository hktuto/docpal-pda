package com.docpal.warehousepda.data.db

import android.content.Context
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.offMainThread
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SeedImportTest {

    private lateinit var db: AppDatabase

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
    }

    @After
    fun tearDown() {
        db.close()
    }

    // Shared helper from DbTestSupport.kt runs queries on a background thread
    // (AppDatabase.build intentionally disallows main-thread queries).
    private fun count(table: String): Int = offMainThread {
        db.query(SimpleSQLiteQuery("SELECT COUNT(*) FROM $table")).use { cursor ->
            cursor.moveToFirst()
            cursor.getInt(0)
        }
    }

    @Test
    fun `seed row counts match the web demo`() {
        assertEquals(2, count("users"))
        assertEquals(26, count("suppliers"))
        assertEquals(11, count("shelves"))
        assertEquals(1, count("receiving_orders"))
        assertEquals(23, count("picking_orders"))
        assertEquals(73, count("picking_items"))
        // Precalc preset ships 73 pre-computed allocations.
        assertEquals(73, count("allocations"))
        // Approximate counts in the seed source (~177 / ~16 / ~264).
        assertTrue(count("parts") >= 170)
        assertTrue(count("receiving_invoices") >= 15)
        assertTrue(count("receiving_invoice_items") >= 260)
    }

    @Test
    fun `timestamps imported as epoch millis`() = offMainThread {
        db.query(SimpleSQLiteQuery("SELECT created_at FROM users LIMIT 1")).use { cursor ->
            cursor.moveToFirst()
            assertTrue("expected epoch-ms integer", cursor.getLong(0) > 1_000_000_000_000L)
        }
    }

    @Test
    fun `KOA supplier qrcode template survives the round trip`() = offMainThread {
        db.query(SimpleSQLiteQuery("SELECT qrcode_template FROM suppliers WHERE code = 'KOA'")).use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertFalse("qrcode_template should be non-NULL for KOA", cursor.isNull(0))
            assertTrue(cursor.getString(0).isNotEmpty())
        }
    }
}
