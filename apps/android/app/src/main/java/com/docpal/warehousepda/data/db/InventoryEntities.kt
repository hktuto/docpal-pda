package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "inventory_lots",
    // SQLite treats NULLs as distinct in unique indexes, so this plain unique
    // index is equivalent to the web's partial index on located lots (design
    // decision 2 in the Phase 0 plan).
    indices = [
        Index(
            value = ["part_id", "date_code", "coo", "cow", "shelf_code", "box_id"],
            unique = true
        ),
        Index(name = "idx_inventory_lots_location", value = ["shelf_code", "box_id"]),
    ]
)
data class InventoryLotEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
    @ColumnInfo(name = "shelf_code") val shelfCode: String?,
    @ColumnInfo(name = "box_id") val boxId: String?,
    @ColumnInfo(name = "total_qty", defaultValue = "0") val totalQty: Int,
    @ColumnInfo(name = "allocated_qty", defaultValue = "0") val allocatedQty: Int,
    // Plain column maintained by repositories (design decision 1); the web
    // schema has this as a generated column.
    @ColumnInfo(name = "available_qty", defaultValue = "0") val availableQty: Int,
)

@Entity(
    tableName = "inventory_lot_sources",
    indices = [
        Index(value = ["inventory_lot_id", "receiving_invoice_item_id"], unique = true),
        Index(name = "idx_inventory_lot_sources_receiving_item", value = ["receiving_invoice_item_id"]),
    ]
)
data class InventoryLotSourceEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "inventory_lot_id") val inventoryLotId: String,
    @ColumnInfo(name = "receiving_invoice_item_id") val receivingInvoiceItemId: String,
    val qty: Int,
)

@Entity(
    tableName = "allocations",
    indices = [
        Index(name = "idx_allocations_picking_item", value = ["picking_item_id"]),
        Index(name = "idx_allocations_lot", value = ["inventory_lot_id"]),
        Index(name = "idx_allocations_receiving_order", value = ["receiving_order_id"]),
    ]
)
data class AllocationEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "picking_item_id") val pickingItemId: String,
    @ColumnInfo(name = "inventory_lot_id") val inventoryLotId: String?,
    @ColumnInfo(name = "receiving_order_id") val receivingOrderId: String?,
    val qty: Int,
    val remark: String?,
)
