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

    @Test
    fun `creates key non-unique indexes mirroring the web schema`() {
        db.query(
            SimpleSQLiteQuery(
                "SELECT name FROM sqlite_master WHERE type='index' " +
                    "AND name LIKE 'idx_%'"
            )
        ).use { cursor ->
            val names = buildSet {
                while (cursor.moveToNext()) add(cursor.getString(0))
            }
            assertEquals(
                setOf(
                    "idx_allocations_lot",
                    "idx_allocations_picking_item",
                    "idx_allocations_receiving_order",
                    "idx_inventory_lots_location",
                    "idx_inventory_lot_sources_receiving_item",
                    "idx_picking_items_order",
                    "idx_picking_items_part",
                    "idx_picking_orders_status",
                    "idx_picking_packages_box",
                    "idx_picking_packages_item",
                    "idx_picking_packages_order",
                    "idx_put_away_scans_box",
                    "idx_put_away_scans_item",
                    "idx_receiving_invoice_items_invoice",
                    "idx_receiving_invoice_items_part",
                    "idx_receiving_item_mismatches_item",
                    "idx_receiving_item_mismatches_status",
                    "idx_receiving_orders_status",
                    "idx_shelf_boxes_order",
                    "idx_shelf_boxes_shelf",
                    "idx_shipping_boxes_order",
                    "idx_shipping_boxes_task",
                    "idx_transition_logs_created_at",
                    "idx_transition_logs_entity",
                ),
                names
            )
        }
    }
}
