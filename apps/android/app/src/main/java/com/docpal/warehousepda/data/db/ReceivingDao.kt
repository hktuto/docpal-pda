package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface ReceivingDao {

    @Query(
        """
        SELECT ro.id, ro.ref_no, ro.status, ro.delivery_date, s.name AS supplier_name,
               ri.invoice_no, rii.id AS item_id, rii.part_id, rii.date_code,
               (rii.received_qty - rii.picked_qty - rii.put_away_qty) AS gross_qty
        FROM receiving_orders ro
        LEFT JOIN suppliers s ON s.id = ro.supplier_id
        LEFT JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        LEFT JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        WHERE (:filter = 'all')
           OR (:filter = 'pending' AND ro.status = 'pending')
           OR (:filter = 'in_hand' AND ro.status = 'in_hand')
           OR (:filter = 'clear' AND ro.status = 'clear')
        ORDER BY (ro.delivery_date IS NULL), ro.delivery_date, ri.invoice_no, rii.id
        """
    )
    fun listOrderRows(filter: String): List<OrderItemFlatRow>

    @Query(
        """
        SELECT a.receiving_order_id, pi.part_id, COALESCE(SUM(a.qty), 0) AS total_qty
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE a.receiving_order_id IS NOT NULL
        GROUP BY a.receiving_order_id, pi.part_id
        """
    )
    fun orderAllocationTotals(): List<OrderAllocationTotalRow>

    @Query(
        """
        SELECT pas.receiving_invoice_item_id AS item_id, COALESCE(SUM(pas.qty), 0) AS qty
        FROM put_away_scans pas
        WHERE pas.shelf_box_id IS NULL AND pas.receiving_invoice_item_id IS NOT NULL
        GROUP BY pas.receiving_invoice_item_id
        """
    )
    fun unboxedPutAwayScanTotals(): List<ItemQtyRow>

    /** Distinct pending/picking picking-order ids linked to each receiving order (two link paths, deduped in Kotlin). */
    @Query(
        """
        SELECT a.receiving_order_id AS receiving_order_id, po.id AS picking_order_id
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE a.receiving_order_id IS NOT NULL AND a.qty > 0
          AND po.status IN ('pending', 'picking')
        UNION ALL
        SELECT ri2.receiving_order_id AS receiving_order_id, po.id AS picking_order_id
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        JOIN inventory_lots il ON il.id = a.inventory_lot_id
        JOIN inventory_lot_sources ils ON ils.inventory_lot_id = il.id
        JOIN receiving_invoice_items rii2 ON rii2.id = ils.receiving_invoice_item_id
        JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
        WHERE a.qty > 0 AND po.status IN ('pending', 'picking')
        """
    )
    fun pendingPickingOrderLinks(): List<OrderPickingLinkRow>

    @Query("SELECT * FROM receiving_orders WHERE id = :id")
    fun orderById(id: String): ReceivingOrderEntity?

    @Query("SELECT name FROM suppliers WHERE id = :id")
    fun supplierName(id: String): String?

    @Query(
        """
        SELECT ri.id AS invoice_id, ri.invoice_no,
               rii.id AS item_id, rii.part_id, p.part_no, rii.po_no, rii.po_line,
               rii.qty, rii.received_qty, rii.picked_qty, rii.put_away_qty,
               rii.box_id, rii.date_code, rii.lot_code, rii.coo, rii.cow
        FROM receiving_invoices ri
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        JOIN parts p ON p.id = rii.part_id
        WHERE ri.receiving_order_id = :orderId
        ORDER BY ri.invoice_no, rii.id
        """
    )
    fun detailItemRows(orderId: String): List<DetailItemFlatRow>

    @Query(
        """
        SELECT * FROM receiving_item_mismatches
        WHERE receiving_invoice_item_id IN (:itemIds) AND status != 'cancelled'
        ORDER BY reported_at DESC
        """
    )
    fun activeMismatches(itemIds: List<String>): List<ReceivingItemMismatchEntity>

    /** Port of web getPickingOrdersByReceivingOrder; DISTINCT ON (a.id) → GROUP BY a.id. */
    @Query(
        """
        WITH lot_allocations AS (
          SELECT
            po.id AS picking_order_id, po.ref_no AS picking_order_ref,
            po.status AS picking_order_status, po.ship_to AS picking_order_ship_to,
            pi.id AS picking_item_id, pi.qty AS required_qty, pi.picked_qty,
            p.id AS part_id, p.part_no,
            il.shelf_code, il.box_id, il.date_code, il.lot_code, il.coo, il.cow,
            a.qty AS allocated_qty, a.id AS allocation_id
          FROM receiving_orders ro
          JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
          JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
          JOIN inventory_lot_sources ils ON ils.receiving_invoice_item_id = rii.id
          JOIN inventory_lots il ON il.id = ils.inventory_lot_id
          JOIN allocations a ON a.inventory_lot_id = il.id
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          JOIN parts p ON p.id = pi.part_id
          WHERE ro.id = :receivingOrderId
          GROUP BY a.id
        ),
        invoice_allocations AS (
          SELECT
            po.id AS picking_order_id, po.ref_no AS picking_order_ref,
            po.status AS picking_order_status, po.ship_to AS picking_order_ship_to,
            pi.id AS picking_item_id, pi.qty AS required_qty, pi.picked_qty,
            p.id AS part_id, p.part_no,
            NULL AS shelf_code, NULL AS box_id, NULL AS date_code, NULL AS lot_code,
            NULL AS coo, NULL AS cow,
            a.qty AS allocated_qty, a.id AS allocation_id
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          JOIN parts p ON p.id = pi.part_id
          WHERE a.receiving_order_id = :receivingOrderId
        ),
        combined AS (
          SELECT * FROM lot_allocations
          UNION ALL
          SELECT * FROM invoice_allocations
        ),
        package_totals AS (
          SELECT picking_item_id,
                 COALESCE(SUM(CASE WHEN shipping_box_id IS NULL THEN qty ELSE 0 END), 0) AS scanned_qty,
                 COALESCE(SUM(CASE WHEN shipping_box_id IS NOT NULL THEN qty ELSE 0 END), 0) AS boxed_qty
          FROM picking_packages
          GROUP BY picking_item_id
        )
        SELECT c.*, COALESCE(pt.scanned_qty, 0) AS scanned_qty,
               COALESCE(pt.boxed_qty, 0) AS boxed_qty
        FROM combined c
        LEFT JOIN package_totals pt ON pt.picking_item_id = c.picking_item_id
        ORDER BY c.picking_order_ref, c.part_no
        """
    )
    fun pickingRowsByReceivingOrder(receivingOrderId: String): List<PickingRowFlat>

    @Query(
        """
        SELECT * FROM picking_packages
        WHERE picking_item_id IN (:itemIds)
        ORDER BY created_at
        """
    )
    fun packagesByItemIds(itemIds: List<String>): List<PickingPackageEntity>

    @Query(
        """
        SELECT id, picking_order_id, status FROM shipping_boxes
        WHERE picking_order_id IN (:orderIds)
        ORDER BY id
        """
    )
    fun boxesByOrderIds(orderIds: List<String>): List<BoxFlatRow>

    @Query(
        """
        SELECT tl.id, tl.entity_id, tl.from_state, tl.to_state, tl.metadata,
               tl.created_at, u.display_name AS actor_name
        FROM transition_logs tl
        LEFT JOIN users u ON u.id = tl.actor_id
        WHERE tl.entity_type = 'picking_item' AND tl.entity_id IN (:itemIds)
        ORDER BY tl.created_at DESC
        """
    )
    fun pickingItemLogs(itemIds: List<String>): List<LogFlatRow>

    @Query("SELECT * FROM receiving_invoices WHERE receiving_order_id = :orderId")
    fun invoicesOfOrder(orderId: String): List<ReceivingInvoiceEntity>

    @Query("SELECT * FROM receiving_invoice_items WHERE receiving_invoice_id IN (:invoiceIds)")
    fun itemsOfInvoices(invoiceIds: List<String>): List<ReceivingInvoiceItemEntity>

    @Query("UPDATE receiving_orders SET status = :status, updated_at = :now WHERE id = :orderId")
    fun updateOrderStatus(orderId: String, status: String, now: Long)

    @Insert
    fun insertTransitionLog(log: TransitionLogEntity)
}

data class OrderItemFlatRow(
    val id: String,
    @ColumnInfo(name = "ref_no") val refNo: String,
    val status: String,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(name = "supplier_name") val supplierName: String?,
    @ColumnInfo(name = "invoice_no") val invoiceNo: String?,
    @ColumnInfo(name = "item_id") val itemId: String?,
    @ColumnInfo(name = "part_id") val partId: String?,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "gross_qty") val grossQty: Int?,
)

data class OrderAllocationTotalRow(
    @ColumnInfo(name = "receiving_order_id") val receivingOrderId: String,
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "total_qty") val totalQty: Int,
)

data class ItemQtyRow(
    @ColumnInfo(name = "item_id") val itemId: String,
    val qty: Int,
)

data class OrderPickingLinkRow(
    @ColumnInfo(name = "receiving_order_id") val receivingOrderId: String,
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String,
)

data class DetailItemFlatRow(
    @ColumnInfo(name = "invoice_id") val invoiceId: String,
    @ColumnInfo(name = "invoice_no") val invoiceNo: String,
    @ColumnInfo(name = "item_id") val itemId: String,
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "part_no") val partNo: String,
    @ColumnInfo(name = "po_no") val poNo: String?,
    @ColumnInfo(name = "po_line") val poLine: String?,
    val qty: Int,
    @ColumnInfo(name = "received_qty") val receivedQty: Int,
    @ColumnInfo(name = "picked_qty") val pickedQty: Int,
    @ColumnInfo(name = "put_away_qty") val putAwayQty: Int,
    @ColumnInfo(name = "box_id") val boxId: String?,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
)

data class PickingRowFlat(
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String,
    @ColumnInfo(name = "picking_order_ref") val pickingOrderRef: String,
    @ColumnInfo(name = "picking_order_status") val pickingOrderStatus: String,
    @ColumnInfo(name = "picking_order_ship_to") val pickingOrderShipTo: String?,
    @ColumnInfo(name = "picking_item_id") val pickingItemId: String,
    @ColumnInfo(name = "required_qty") val requiredQty: Int,
    @ColumnInfo(name = "picked_qty") val pickedQty: Int,
    @ColumnInfo(name = "scanned_qty") val scannedQty: Int,
    @ColumnInfo(name = "boxed_qty") val boxedQty: Int,
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "part_no") val partNo: String,
    @ColumnInfo(name = "shelf_code") val shelfCode: String?,
    @ColumnInfo(name = "box_id") val boxId: String?,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
    @ColumnInfo(name = "allocated_qty") val allocatedQty: Int,
    @ColumnInfo(name = "allocation_id") val allocationId: String,
)

data class BoxFlatRow(
    val id: String,
    @ColumnInfo(name = "picking_order_id") val pickingOrderId: String?,
    val status: String,
)

data class LogFlatRow(
    val id: String,
    @ColumnInfo(name = "entity_id") val entityId: String,
    @ColumnInfo(name = "from_state") val fromState: String?,
    @ColumnInfo(name = "to_state") val toState: String,
    val metadata: String?,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "actor_name") val actorName: String?,
)
