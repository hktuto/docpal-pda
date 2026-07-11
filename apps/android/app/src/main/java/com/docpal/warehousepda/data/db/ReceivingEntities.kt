package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "receiving_orders",
    indices = [Index(name = "idx_receiving_orders_status", value = ["status"])]
)
data class ReceivingOrderEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "ref_no") val refNo: String,
    @ColumnInfo(name = "supplier_id") val supplierId: String?,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(defaultValue = "pending") val status: String,
    @ColumnInfo(name = "arrived_at") val arrivedAt: Long?,
    @ColumnInfo(name = "arrived_by") val arrivedBy: String?,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Entity(tableName = "receiving_invoices")
data class ReceivingInvoiceEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "receiving_order_id") val receivingOrderId: String,
    @ColumnInfo(name = "invoice_no") val invoiceNo: String,
    @ColumnInfo(name = "supplier_id") val supplierId: String?,
)

@Entity(
    tableName = "receiving_invoice_items",
    indices = [
        Index(name = "idx_receiving_invoice_items_invoice", value = ["receiving_invoice_id"]),
        Index(name = "idx_receiving_invoice_items_part", value = ["part_id"]),
    ]
)
data class ReceivingInvoiceItemEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "receiving_invoice_id") val receivingInvoiceId: String,
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "po_no") val poNo: String?,
    @ColumnInfo(name = "po_line") val poLine: String?,
    val qty: Int,
    @ColumnInfo(name = "received_qty", defaultValue = "0") val receivedQty: Int,
    @ColumnInfo(name = "picked_qty", defaultValue = "0") val pickedQty: Int,
    @ColumnInfo(name = "put_away_qty", defaultValue = "0") val putAwayQty: Int,
    @ColumnInfo(name = "box_id") val boxId: String?,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
)

@Entity(
    tableName = "receiving_item_mismatches",
    indices = [
        Index(name = "idx_receiving_item_mismatches_item", value = ["receiving_invoice_item_id"]),
        Index(name = "idx_receiving_item_mismatches_status", value = ["status"]),
    ]
)
data class ReceivingItemMismatchEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "receiving_invoice_item_id") val receivingInvoiceItemId: String,
    val reason: String,
    @ColumnInfo(name = "mismatch_qty") val mismatchQty: Int?,
    @ColumnInfo(name = "wrong_part_no") val wrongPartNo: String?,
    val note: String?,
    @ColumnInfo(defaultValue = "pending") val status: String,
    @ColumnInfo(name = "effective_received_qty") val effectiveReceivedQty: Int,
    @ColumnInfo(name = "previous_received_qty") val previousReceivedQty: Int,
    @ColumnInfo(name = "reported_by") val reportedBy: String?,
    @ColumnInfo(name = "reported_at") val reportedAt: Long,
    @ColumnInfo(name = "confirmed_by") val confirmedBy: String?,
    @ColumnInfo(name = "confirmed_at") val confirmedAt: Long?,
    @ColumnInfo(name = "cancelled_by") val cancelledBy: String?,
    @ColumnInfo(name = "cancelled_at") val cancelledAt: Long?,
)
