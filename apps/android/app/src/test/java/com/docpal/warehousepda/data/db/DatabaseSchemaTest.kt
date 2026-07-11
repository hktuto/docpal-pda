package com.docpal.warehousepda.data.db

import android.content.Context
import androidx.room.Room
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DatabaseSchemaTest {

    private lateinit var db: AppDatabase

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun `creates exactly the 19 app tables`() {
        db.query(
            SimpleSQLiteQuery(
                "SELECT name FROM sqlite_master WHERE type='table' " +
                    "AND name NOT LIKE 'android_%' AND name NOT LIKE 'sqlite_%' " +
                    "AND name != 'room_master_table' ORDER BY name"
            )
        ).use { cursor ->
            val names = buildList {
                while (cursor.moveToNext()) add(cursor.getString(0))
            }
            assertEquals(
                listOf(
                    "allocations", "inventory_lot_sources", "inventory_lots",
                    "measuring_tasks", "parts", "picking_items", "picking_orders",
                    "picking_packages", "put_away_scans", "receiving_invoice_items",
                    "receiving_invoices", "receiving_item_mismatches",
                    "receiving_orders", "shelf_boxes", "shelves", "shipping_boxes",
                    "suppliers", "transition_logs", "users"
                ),
                names
            )
        }
    }
}
