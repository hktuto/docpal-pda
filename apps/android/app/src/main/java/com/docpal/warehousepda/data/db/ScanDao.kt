package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Query

@Dao
interface ScanDao {

    @Query("SELECT code, qrcode_template, qrcode_qty_encoding FROM suppliers WHERE qrcode_template IS NOT NULL")
    fun supplierQrTemplates(): List<SupplierQrTemplateRow>

    /** Raw receiving candidate rows; normalization + available-qty filtering happen in Kotlin. */
    @Query(
        """
        SELECT rii.id AS receiving_invoice_item_id, p.id AS part_id, p.part_no,
               ri.invoice_no, rii.date_code, rii.lot_code, rii.coo, rii.cow,
               rii.received_qty, rii.picked_qty, rii.put_away_qty
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        JOIN parts p ON p.id = rii.part_id
        WHERE ro.id = :receivingOrderId AND ro.status = 'in_hand'
        """
    )
    fun receivingCandidateRows(receivingOrderId: String): List<ReceivingCandidateRow>

    /** Raw picking candidate rows; remaining-qty math mirrored from the web (unboxed packages subquery). */
    @Query(
        """
        SELECT DISTINCT
          po.id AS picking_order_id, po.ref_no AS picking_order_ref_no,
          pi.id AS picking_item_id, pi.part_id, po.ship_to,
          pi.qty AS required_qty, pi.picked_qty,
          COALESCE((
            SELECT SUM(pp.qty) FROM picking_packages pp
            WHERE pp.picking_item_id = pi.id AND pp.shipping_box_id IS NULL
          ), 0) AS scanned_not_boxed_qty
        FROM picking_items pi
        JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE pi.part_id = :partId AND po.status != 'finished'
          AND EXISTS (
            SELECT 1 FROM picking_items pi2
            JOIN allocations a ON a.picking_item_id = pi2.id
            WHERE pi2.picking_order_id = po.id AND a.receiving_order_id = :receivingOrderId
          )
        ORDER BY po.ref_no
        """
    )
    fun pickingCandidateRows(receivingOrderId: String, partId: String): List<PickingCandidateRow>
}

data class SupplierQrTemplateRow(
    val code: String,
    @ColumnInfo(name = "qrcode_template") val qrcodeTemplate: String,
    @ColumnInfo(name = "qrcode_qty_encoding") val qrcodeQtyEncoding: String?,
)

data class ReceivingCandidateRow(
    @ColumnInfo(name = "receiving_invoice_item_id") val receivingInvoiceItemId: String,
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "part_no") val partNo: String,
    @ColumnInfo(name = "invoice_no") val invoiceNo: String,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
    @ColumnInfo(name = "received_qty") val receivedQty: Int,
    @ColumnInfo(name = "picked_qty") val pickedQty: Int,
    @ColumnInfo(name = "put_away_qty") val putAwayQty: Int,
)

data class PickingCandidateRow(
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String,
    @ColumnInfo(name = "picking_order_ref_no") val pickingOrderRefNo: String,
    @ColumnInfo(name = "picking_item_id") val pickingItemId: String,
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "ship_to") val shipTo: String?,
    @ColumnInfo(name = "required_qty") val requiredQty: Int,
    @ColumnInfo(name = "picked_qty") val pickedQty: Int,
    @ColumnInfo(name = "scanned_not_boxed_qty") val scannedNotBoxedQty: Int,
)
