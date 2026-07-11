package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "measuring_tasks",
    indices = [Index(value = ["picking_order_id"], unique = true)]
)
data class MeasuringTaskEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String,
    @ColumnInfo(defaultValue = "pending") val status: String,
    @ColumnInfo(name = "created_at") val createdAt: Long,
)

@Entity(
    tableName = "shipping_boxes",
    indices = [
        Index(name = "idx_shipping_boxes_task", value = ["measuring_task_id"]),
        Index(name = "idx_shipping_boxes_order", value = ["picking_order_id"]),
    ]
)
data class ShippingBoxEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String?,
    @ColumnInfo(name = "measuring_task_id") val measuringTaskId: String?,
    @ColumnInfo(defaultValue = "open") val status: String,
    @ColumnInfo(name = "gross_weight") val grossWeight: Double?,
    @ColumnInfo(name = "net_weight") val netWeight: Double?,
    @ColumnInfo(name = "destination_country") val destinationCountry: String?,
    @ColumnInfo(name = "box_size") val boxSize: String?,
    @ColumnInfo(name = "created_at") val createdAt: Long,
)

@Entity(
    tableName = "shelf_boxes",
    indices = [
        Index(name = "idx_shelf_boxes_order", value = ["receiving_order_id"]),
        Index(name = "idx_shelf_boxes_shelf", value = ["shelf_code"]),
    ]
)
data class ShelfBoxEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "receiving_order_id") val receivingOrderId: String?,
    @ColumnInfo(name = "shelf_code") val shelfCode: String?,
    @ColumnInfo(defaultValue = "open") val status: String,
    @ColumnInfo(name = "created_at") val createdAt: Long,
)

@Entity(
    tableName = "put_away_scans",
    indices = [
        Index(name = "idx_put_away_scans_item", value = ["receiving_invoice_item_id"]),
        Index(name = "idx_put_away_scans_box", value = ["shelf_box_id"]),
    ]
)
data class PutAwayScanEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "receiving_invoice_item_id") val receivingInvoiceItemId: String?,
    @ColumnInfo(name = "part_id") val partId: String,
    val qty: Int,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
    @ColumnInfo(name = "shelf_box_id") val shelfBoxId: String?,
    @ColumnInfo(defaultValue = "0") val verified: Boolean,
    @ColumnInfo(name = "verified_at") val verifiedAt: Long?,
    @ColumnInfo(name = "created_at") val createdAt: Long,
)
