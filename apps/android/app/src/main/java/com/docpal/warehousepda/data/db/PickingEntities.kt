package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "picking_orders",
    indices = [Index(name = "idx_picking_orders_status", value = ["status"])]
)
data class PickingOrderEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "ref_no") val refNo: String,
    @ColumnInfo(name = "supplier_id") val supplierId: String?,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(name = "po_no") val poNo: String?,
    @ColumnInfo(name = "required_date_code_notice") val requiredDateCodeNotice: String?,
    @ColumnInfo(name = "ship_to") val shipTo: String?,
    @ColumnInfo(name = "destination_country") val destinationCountry: String?,
    @ColumnInfo(defaultValue = "pending") val status: String,
    @ColumnInfo(name = "issue_reason") val issueReason: String?,
    @ColumnInfo(name = "issue_qty") val issueQty: Int?,
    @ColumnInfo(name = "issue_pack_size") val issuePackSize: Int?,
    @ColumnInfo(name = "issue_note") val issueNote: String?,
    @ColumnInfo(name = "issue_remark") val issueRemark: String?,
    @ColumnInfo(name = "issue_reported_at") val issueReportedAt: Long?,
    @ColumnInfo(name = "issue_reported_by") val issueReportedBy: String?,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Entity(
    tableName = "picking_items",
    indices = [
        Index(name = "idx_picking_items_order", value = ["picking_order_id"]),
        Index(name = "idx_picking_items_part", value = ["part_id"]),
    ]
)
data class PickingItemEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String,
    @ColumnInfo(name = "part_id") val partId: String,
    val qty: Int,
    @ColumnInfo(name = "picked_qty", defaultValue = "0") val pickedQty: Int,
    @ColumnInfo(name = "allocated_qty", defaultValue = "0") val allocatedQty: Int,
    @ColumnInfo(name = "required_date_code") val requiredDateCode: String?,
    @ColumnInfo(name = "source_shelf_code") val sourceShelfCode: String?,
)

@Entity(
    tableName = "picking_packages",
    indices = [
        Index(name = "idx_picking_packages_item", value = ["picking_item_id"]),
        Index(name = "idx_picking_packages_order", value = ["picking_order_id"]),
        Index(name = "idx_picking_packages_box", value = ["shipping_box_id"]),
    ]
)
data class PickingPackageEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "picking_item_id") val pickingItemId: String,
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String,
    @ColumnInfo(name = "source_type") val sourceType: String,
    @ColumnInfo(name = "source_id") val sourceId: String,
    val qty: Int,
    @ColumnInfo(name = "shipping_box_id") val shippingBoxId: String?,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
    @ColumnInfo(defaultValue = "0") val verified: Boolean,
    @ColumnInfo(name = "created_at") val createdAt: Long,
)
