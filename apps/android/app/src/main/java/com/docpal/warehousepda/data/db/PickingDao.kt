package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface PickingDao {

    @Query("SELECT * FROM picking_orders WHERE status = 'pending'")
    fun pendingPickingOrders(): List<PickingOrderEntity>

    @Query("SELECT * FROM picking_orders WHERE id = :id")
    fun pickingOrderById(id: String): PickingOrderEntity?

    /** Picking list: all orders, finished sink last, then delivery_date (nulls last); web pgliteWarehouse listOrders query. */
    @Query(
        """
        SELECT po.id, po.ref_no, po.status, po.delivery_date, po.ship_to, s.name AS supplier_name,
          (SELECT COALESCE(SUM(pi.qty), 0) FROM picking_items pi WHERE pi.picking_order_id = po.id) AS total_qty
        FROM picking_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        ORDER BY CASE WHEN po.status = 'finished' THEN 1 ELSE 0 END, (po.delivery_date IS NULL), po.delivery_date
        """
    )
    fun pickingOrderSummaryRows(): List<PickingOrderSummaryRow>

    @Query("SELECT * FROM picking_items WHERE picking_order_id = :orderId")
    fun itemsOfPickingOrder(orderId: String): List<PickingItemEntity>

    @Query("SELECT * FROM picking_items WHERE id = :id")
    fun pickingItemById(id: String): PickingItemEntity?

    @Query(
        """
        SELECT * FROM inventory_lots
        WHERE part_id = :partId AND available_qty > 0
          AND (shelf_code IS NOT NULL OR box_id IS NOT NULL)
        """
    )
    fun locatedLotsForPart(partId: String): List<InventoryLotEntity>

    // SQLite evaluates all SET expressions against the pre-update row, so the RHS
    // allocated_qty is the old value: available_qty is recomputed as total minus the NEW allocated total.
    @Query("UPDATE inventory_lots SET allocated_qty = allocated_qty + :qty, available_qty = total_qty - (allocated_qty + :qty) WHERE id = :lotId")
    fun increaseLotAllocated(lotId: String, qty: Int)

    @Query("UPDATE picking_items SET allocated_qty = allocated_qty + :qty WHERE id = :itemId")
    fun increaseItemAllocated(itemId: String, qty: Int)

    @Query("UPDATE picking_items SET allocated_qty = allocated_qty - :qty WHERE id = :itemId")
    fun decreaseItemAllocated(itemId: String, qty: Int)

    /** Receiving-side availability per (order) for a part — web allocate.ts Phase 2 query. */
    @Query(
        """
        SELECT ro.id AS receiving_order_id, ro.delivery_date,
               COALESCE(SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty), 0) AS physical_qty,
               COALESCE((
                 SELECT SUM(a.qty) FROM allocations a
                 JOIN picking_items pi ON pi.id = a.picking_item_id
                 WHERE a.receiving_order_id = ro.id AND pi.part_id = :partId
               ), 0) AS allocated_qty,
               COALESCE((
                 SELECT SUM(pas.qty) FROM put_away_scans pas
                 JOIN receiving_invoice_items rii2 ON rii2.id = pas.receiving_invoice_item_id
                 JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
                 WHERE ri2.receiving_order_id = ro.id AND rii2.part_id = :partId
                   AND pas.shelf_box_id IS NULL
               ), 0) AS unboxed_qty
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        WHERE rii.part_id = :partId AND ro.status = 'in_hand'
        GROUP BY ro.id, ro.delivery_date
        HAVING physical_qty - allocated_qty - unboxed_qty > 0
        ORDER BY (ro.delivery_date IS NULL), ro.delivery_date
        """
    )
    fun receivingAvailabilityForPart(partId: String): List<ReceivingAvailabilityRow>

    @Query(
        """
        SELECT DISTINCT rii.box_id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = :orderId AND rii.part_id = :partId AND rii.box_id IS NOT NULL
        """
    )
    fun boxIdsForOrderPart(orderId: String, partId: String): List<String>

    @Insert
    fun insertAllocation(allocation: AllocationEntity)

    @Query("SELECT * FROM allocations WHERE id = :id")
    fun allocationById(id: String): AllocationEntity?

    @Query(
        """
        SELECT * FROM allocations
        WHERE receiving_order_id = :orderId AND picking_item_id = :itemId AND qty > 0
        ORDER BY id
        """
    )
    fun coarseAllocations(orderId: String, itemId: String): List<AllocationEntity>

    @Query("SELECT * FROM allocations WHERE inventory_lot_id = :lotId AND picking_item_id = :itemId LIMIT 1")
    fun allocationByLotAndItem(lotId: String, itemId: String): AllocationEntity?

    @Query("UPDATE allocations SET qty = qty - :qty WHERE id = :id")
    fun decreaseAllocationQty(id: String, qty: Int)

    @Query("UPDATE allocations SET qty = qty + :qty WHERE id = :id")
    fun increaseAllocationQty(id: String, qty: Int)

    /** Moves a coarse allocation onto a lot (web materializeReceivingAllocation full-move branch). */
    @Query("UPDATE allocations SET inventory_lot_id = :lotId, receiving_order_id = NULL WHERE id = :id")
    fun moveAllocationToLot(id: String, lotId: String)

    @Query("DELETE FROM allocations WHERE id = :id")
    fun deleteAllocation(id: String)

    @Query(
        """
        SELECT COALESCE(SUM(qty), 0) FROM picking_packages
        WHERE picking_item_id = :itemId AND shipping_box_id IS NULL
        """
    )
    fun unboxedPackageQty(itemId: String): Int

    @Query(
        """
        SELECT COALESCE(SUM(qty), 0) FROM picking_packages
        WHERE picking_item_id = :itemId AND shipping_box_id IS NOT NULL
        """
    )
    fun boxedPackageQty(itemId: String): Int

    @Query(
        """
        SELECT 1 FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        WHERE ro.id = :orderId AND rii.part_id = :partId LIMIT 1
        """
    )
    fun partInReceivingOrder(orderId: String, partId: String): Long?

    /** physical / reserved-by-others / unboxed for an order+part (web applyOcrPick availability query). */
    @Query(
        """
        SELECT
          COALESCE(SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty), 0) AS physical_qty,
          COALESCE((
            SELECT SUM(a.qty) FROM allocations a
            JOIN picking_items pi ON pi.id = a.picking_item_id
            WHERE a.receiving_order_id = :orderId AND pi.part_id = :partId
              AND a.picking_item_id != :pickingItemId
          ), 0) AS reserved_by_others,
          COALESCE((
            SELECT SUM(pas.qty) FROM put_away_scans pas
            JOIN receiving_invoice_items rii2 ON rii2.id = pas.receiving_invoice_item_id
            JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
            WHERE ri2.receiving_order_id = :orderId AND rii2.part_id = :partId
              AND pas.shelf_box_id IS NULL
          ), 0) AS unboxed_qty
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        WHERE ro.id = :orderId AND rii.part_id = :partId
        """
    )
    fun receivingAvailabilityForScan(orderId: String, partId: String, pickingItemId: String): ScanAvailabilityRow

    /** FIFO invoice items for the split (web invoiceItems query in applyOcrPick). */
    @Query(
        """
        SELECT rii.id AS item_id, ri.invoice_no, rii.received_qty, rii.picked_qty, rii.put_away_qty, rii.date_code
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        WHERE ro.id = :orderId AND rii.part_id = :partId
        ORDER BY (ro.delivery_date IS NULL), ro.delivery_date, ri.invoice_no, (rii.date_code IS NULL), rii.date_code
        """
    )
    fun fifoInvoiceItemsForScan(orderId: String, partId: String): List<FifoItemRow>

    @Query("SELECT * FROM inventory_lots WHERE id = :id")
    fun lotById(id: String): InventoryLotEntity?

    @Query("SELECT * FROM inventory_lot_sources WHERE inventory_lot_id = :lotId ORDER BY id")
    fun lotSources(lotId: String): List<InventoryLotSourceEntity>

    @Query("UPDATE inventory_lots SET total_qty = total_qty - :qty, allocated_qty = allocated_qty - :qty WHERE id = :id")
    fun decreaseLotQtys(id: String, qty: Int)

    @Query("UPDATE inventory_lots SET total_qty = total_qty + :qty, allocated_qty = allocated_qty + :qty WHERE id = :id")
    fun increaseLotQtys(id: String, qty: Int)

    @Query("UPDATE inventory_lot_sources SET qty = qty - :qty WHERE id = :id")
    fun decreaseLotSourceQty(id: String, qty: Int)

    @Query("UPDATE inventory_lot_sources SET qty = qty + :qty WHERE id = :id")
    fun increaseLotSourceQty(id: String, qty: Int)

    @Query("UPDATE receiving_invoice_items SET picked_qty = picked_qty + :qty WHERE id = :id")
    fun increaseItemPickedQty(id: String, qty: Int)

    @Query("UPDATE receiving_invoice_items SET picked_qty = picked_qty - :qty WHERE id = :id")
    fun decreaseItemPickedQty(id: String, qty: Int)

    @Query("UPDATE picking_items SET picked_qty = :qty WHERE id = :id")
    fun setItemPickedQty(id: String, qty: Int)

    @Query("SELECT receiving_order_id FROM receiving_invoices ri JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id WHERE rii.id = :itemId")
    fun orderIdOfInvoiceItem(itemId: String): String?

    @Query("SELECT * FROM picking_packages WHERE id = :id")
    fun packageById(id: String): PickingPackageEntity?

    @Query("SELECT * FROM picking_packages WHERE picking_order_id = :orderId AND shipping_box_id IS NULL")
    fun unboxedPackagesOfOrder(orderId: String): List<PickingPackageEntity>

    @Query("UPDATE picking_packages SET shipping_box_id = :boxId WHERE id = :id")
    fun assignPackageToBox(id: String, boxId: String)

    @Query("UPDATE picking_packages SET shipping_box_id = NULL, verified = 0 WHERE id = :id")
    fun unassignPackageFromBox(id: String)

    @Query("DELETE FROM picking_packages WHERE id = :id")
    fun deletePackage(id: String)

    @Query("SELECT * FROM shipping_boxes WHERE id = :id")
    fun boxById(id: String): ShippingBoxEntity?

    @Query("SELECT id FROM shipping_boxes WHERE id LIKE :prefix || '%'")
    fun boxIdsWithPrefix(prefix: String): List<String>

    @Query("UPDATE picking_orders SET status = :status, updated_at = :now WHERE id = :id")
    fun updatePickingOrderStatus(id: String, status: String, now: Long)

    @Query("UPDATE shipping_boxes SET measuring_task_id = :taskId WHERE picking_order_id = :orderId")
    fun assignBoxesToMeasuringTask(orderId: String, taskId: String)

    @Insert
    fun insertLot(lot: InventoryLotEntity)

    @Insert
    fun insertLotSource(source: InventoryLotSourceEntity)

    @Insert
    fun insertPackage(pkg: PickingPackageEntity)

    @Insert
    fun insertBox(box: ShippingBoxEntity)

    @Insert
    fun insertMeasuringTask(task: MeasuringTaskEntity)

    @Insert
    fun insertLog(log: TransitionLogEntity)
}

data class ReceivingAvailabilityRow(
    @ColumnInfo(name = "receiving_order_id") val receivingOrderId: String,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(name = "physical_qty") val physicalQty: Int,
    @ColumnInfo(name = "allocated_qty") val allocatedQty: Int,
    @ColumnInfo(name = "unboxed_qty") val unboxedQty: Int,
)

data class ScanAvailabilityRow(
    @ColumnInfo(name = "physical_qty") val physicalQty: Int,
    @ColumnInfo(name = "reserved_by_others") val reservedByOthers: Int,
    @ColumnInfo(name = "unboxed_qty") val unboxedQty: Int,
)

data class FifoItemRow(
    @ColumnInfo(name = "item_id") val itemId: String,
    @ColumnInfo(name = "invoice_no") val invoiceNo: String,
    @ColumnInfo(name = "received_qty") val receivedQty: Int,
    @ColumnInfo(name = "picked_qty") val pickedQty: Int,
    @ColumnInfo(name = "put_away_qty") val putAwayQty: Int,
    @ColumnInfo(name = "date_code") val dateCode: String?,
)

data class PickingOrderSummaryRow(
    val id: String,
    @ColumnInfo(name = "ref_no") val refNo: String,
    val status: String,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(name = "ship_to") val shipTo: String?,
    @ColumnInfo(name = "supplier_name") val supplierName: String?,
    @ColumnInfo(name = "total_qty") val totalQty: Int,
)
