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
}

data class ReceivingAvailabilityRow(
    @ColumnInfo(name = "receiving_order_id") val receivingOrderId: String,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(name = "physical_qty") val physicalQty: Int,
    @ColumnInfo(name = "allocated_qty") val allocatedQty: Int,
    @ColumnInfo(name = "unboxed_qty") val unboxedQty: Int,
)
