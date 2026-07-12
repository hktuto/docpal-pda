package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface PutAwayDao {

    /**
     * Put-away list base rows (web getPutAwayCandidates, putAway.ts): in-hand receiving
     * orders with supplier name, ref_no order. delivery_date rides along because the
     * shared availability math (ReceivingAvailability) sorts items with it; the web's
     * HAVING availability/unboxed filter is applied in PutAwayRepository (SQLite on
     * minSdk 24 has no window functions for the allocation distribution).
     */
    @Query(
        """
        SELECT ro.id, ro.ref_no, ro.status, ro.delivery_date, s.name AS supplier_name
        FROM receiving_orders ro
        LEFT JOIN suppliers s ON s.id = ro.supplier_id
        WHERE ro.status = 'in_hand'
        ORDER BY ro.ref_no
        """
    )
    fun inHandOrderRows(): List<InHandOrderRow>

    /** Put-away detail header: order + supplier name/code (web put-away detail page header). */
    @Query(
        """
        SELECT ro.id, ro.ref_no, ro.status, ro.delivery_date,
               s.name AS supplier_name, s.code AS supplier_code
        FROM receiving_orders ro
        LEFT JOIN suppliers s ON s.id = ro.supplier_id
        WHERE ro.id = :orderId
        """
    )
    fun orderHeaderRow(orderId: String): PutAwayOrderHeaderRow?

    /**
     * Lot base rows for the detail (web getPutAwayLots): invoice items of the order with
     * per-item scan totals. The allocated/available part is merged in PutAwayRepository
     * from the shared ReceivingAvailability math; the web HAVING filter is applied there.
     */
    @Query(
        """
        SELECT rii.id AS item_id, p.part_no, rii.date_code, rii.lot_code, rii.coo, rii.cow,
               rii.qty AS total_qty,
               COALESCE(sc.scanned_qty, 0) AS scanned_qty,
               COALESCE(sc.boxed_qty, 0) AS boxed_qty
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        LEFT JOIN parts p ON p.id = rii.part_id
        LEFT JOIN (
            SELECT receiving_invoice_item_id AS item_id, SUM(qty) AS scanned_qty,
                   SUM(CASE WHEN shelf_box_id IS NOT NULL THEN qty ELSE 0 END) AS boxed_qty
            FROM put_away_scans
            GROUP BY receiving_invoice_item_id
        ) sc ON sc.item_id = rii.id
        WHERE ri.receiving_order_id = :orderId
        ORDER BY p.part_no, rii.date_code
        """
    )
    fun lotRows(orderId: String): List<PutAwayLotRow>

    /** All put-away scans of the order, newest first with id tiebreak (web getPutAwayScansForReceivingOrder: created_at DESC). */
    @Query(
        """
        SELECT pas.id, pas.receiving_invoice_item_id, pas.qty,
               pas.date_code, pas.lot_code, pas.coo, pas.cow, pas.shelf_box_id
        FROM put_away_scans pas
        JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = :orderId
        ORDER BY pas.created_at DESC, pas.id
        """
    )
    fun scanRows(orderId: String): List<PutAwayScanRow>

    /** Shelf boxes of the order with scan totals: open first, then newest (web getShelfBoxesForReceivingOrder). */
    @Query(
        """
        SELECT sb.id, sb.shelf_code, sh.zone, sb.status, sb.created_at,
               COUNT(pas.id) AS line_count, COALESCE(SUM(pas.qty), 0) AS total_qty
        FROM shelf_boxes sb
        LEFT JOIN shelves sh ON sh.code = sb.shelf_code
        LEFT JOIN put_away_scans pas ON pas.shelf_box_id = sb.id
        WHERE sb.receiving_order_id = :orderId
        GROUP BY sb.id
        ORDER BY CASE WHEN sb.status = 'open' THEN 0 ELSE 1 END, sb.created_at DESC, sb.id
        """
    )
    fun boxRows(orderId: String): List<PutAwayBoxRow>

    /** Per-part box contents; grouped per box in PutAwayRepository (web itemsByBox). */
    @Query(
        """
        SELECT pas.shelf_box_id AS box_id, p.part_no, SUM(pas.qty) AS qty
        FROM put_away_scans pas
        JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        LEFT JOIN parts p ON p.id = pas.part_id
        WHERE ri.receiving_order_id = :orderId AND pas.shelf_box_id IS NOT NULL
        GROUP BY pas.shelf_box_id, p.part_no
        ORDER BY p.part_no
        """
    )
    fun boxContentRows(orderId: String): List<PutAwayBoxContentRow>

    /** All shelves for the box shelf-selection dialog. */
    @Query("SELECT code, zone FROM shelves ORDER BY code")
    fun shelfOptionRows(): List<ShelfOptionRow>

    /**
     * Item lookup for recordPutAwayScan: the item's part_id plus its receiving order
     * (the shared availability math needs the order's items and delivery date).
     */
    @Query(
        """
        SELECT rii.part_id AS part_id, ri.receiving_order_id AS order_id
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE rii.id = :itemId
        """
    )
    fun scanItemRow(itemId: String): PutAwayScanItemRow?

    /** Shelf existence check for createShelfBox (web createShelfBox: shelf_not_found). */
    @Query("SELECT code FROM shelves WHERE code = :code")
    fun shelfCodeOf(code: String): String?

    /** API nextShelfBoxId parity: max numeric suffix over live boxes … */
    @Query("SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) FROM shelf_boxes WHERE id LIKE 'SBOX-%'")
    fun maxShelfBoxIdSuffix(): Int?

    /** … and over transition logs (cancelled boxes are hard-deleted; ids are never reissued). */
    @Query("SELECT MAX(CAST(SUBSTR(entity_id, 6) AS INTEGER)) FROM transition_logs WHERE entity_id LIKE 'SBOX-%'")
    fun maxShelfBoxLogIdSuffix(): Int?

    @Query("SELECT * FROM put_away_scans WHERE id = :scanId")
    fun scanById(scanId: String): PutAwayScanEntity?

    @Query("SELECT * FROM shelf_boxes WHERE id = :boxId")
    fun boxById(boxId: String): ShelfBoxEntity?

    /** Unboxed scans of one receiving order, oldest first with id tiebreak (API addAllUnboxedToBox: created_at ASC). */
    @Query(
        """
        SELECT pas.id FROM put_away_scans pas
        JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE pas.shelf_box_id IS NULL AND ri.receiving_order_id = :orderId
        ORDER BY pas.created_at ASC, pas.id
        """
    )
    fun unboxedScanIdsOfOrder(orderId: String): List<String>

    @Query("UPDATE put_away_scans SET shelf_box_id = :boxId WHERE id = :scanId")
    fun assignScanToBox(scanId: String, boxId: String)

    @Query("UPDATE put_away_scans SET shelf_box_id = NULL, verified = 0, verified_at = NULL WHERE id = :scanId")
    fun unassignScanFromBox(scanId: String)

    /**
     * Lot lookup on the merge key — exactly the inventory_lots unique-index columns
     * (part_id, date_code, coo, cow, shelf_code, box_id); lot_code is deliberately NOT
     * part of the key, so scans with differing lot codes merge into the one physical lot
     * per box slot. Null-safe attribute match via IS, like the web's IS comparisons.
     */
    @Query(
        """
        SELECT * FROM inventory_lots
        WHERE part_id = :partId AND date_code IS :dateCode AND coo IS :coo AND cow IS :cow
              AND shelf_code IS :shelfCode AND box_id IS :boxId
        """
    )
    fun lotByMergeKey(
        partId: String,
        dateCode: String?,
        coo: String?,
        cow: String?,
        shelfCode: String?,
        boxId: String?,
    ): InventoryLotEntity?

    @Query("UPDATE inventory_lots SET total_qty = total_qty + :qty, available_qty = available_qty + :qty WHERE id = :id")
    fun increaseLotAvailableQtys(id: String, qty: Int)

    @Query("UPDATE inventory_lots SET total_qty = total_qty - :qty, available_qty = available_qty - :qty WHERE id = :id")
    fun decreaseLotAvailableQtys(id: String, qty: Int)

    @Query("DELETE FROM inventory_lots WHERE id = :id")
    fun deleteLot(id: String)

    @Query("SELECT * FROM inventory_lot_sources WHERE inventory_lot_id = :lotId AND receiving_invoice_item_id = :itemId")
    fun lotSourceByLotAndItem(lotId: String, itemId: String): InventoryLotSourceEntity?

    @Query("UPDATE inventory_lot_sources SET qty = qty + :qty WHERE id = :id")
    fun increaseLotSourceQty(id: String, qty: Int)

    @Query("UPDATE inventory_lot_sources SET qty = qty - :qty WHERE id = :id")
    fun decreaseLotSourceQty(id: String, qty: Int)

    @Query("DELETE FROM inventory_lot_sources WHERE id = :id")
    fun deleteLotSource(id: String)

    /** API removeScanFromBox allocation guard: any allocation row (even fully picked) pins the lot. */
    @Query("SELECT COUNT(*) FROM allocations WHERE inventory_lot_id = :lotId")
    fun allocationCountForLot(lotId: String): Int

    @Query("UPDATE receiving_invoice_items SET put_away_qty = put_away_qty + :qty WHERE id = :id")
    fun increaseItemPutAwayQty(id: String, qty: Int)

    @Query("UPDATE receiving_invoice_items SET put_away_qty = put_away_qty - :qty WHERE id = :id")
    fun decreaseItemPutAwayQty(id: String, qty: Int)

    @Query("SELECT COUNT(*) FROM put_away_scans WHERE shelf_box_id = :boxId")
    fun scanCountInBox(boxId: String): Int

    @Query("UPDATE shelf_boxes SET status = :status WHERE id = :boxId")
    fun updateBoxStatus(boxId: String, status: String)

    /** Hard delete (web cancelShelfBox: cancelled boxes are not persisted; the id survives in transition_logs). */
    @Query("DELETE FROM shelf_boxes WHERE id = :boxId")
    fun deleteBox(boxId: String)

    @Insert
    fun insertScan(scan: PutAwayScanEntity)

    @Insert
    fun insertBox(box: ShelfBoxEntity)

    @Insert
    fun insertLog(log: TransitionLogEntity)

    @Insert
    fun insertLot(lot: InventoryLotEntity)

    @Insert
    fun insertLotSource(source: InventoryLotSourceEntity)

    @Query("DELETE FROM put_away_scans WHERE id = :scanId")
    fun deleteScan(scanId: String)
}

data class InHandOrderRow(
    val id: String,
    @ColumnInfo(name = "ref_no") val refNo: String,
    val status: String,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(name = "supplier_name") val supplierName: String?,
)

data class PutAwayOrderHeaderRow(
    val id: String,
    @ColumnInfo(name = "ref_no") val refNo: String,
    val status: String,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(name = "supplier_name") val supplierName: String?,
    @ColumnInfo(name = "supplier_code") val supplierCode: String?,
)

data class PutAwayLotRow(
    @ColumnInfo(name = "item_id") val itemId: String,
    @ColumnInfo(name = "part_no") val partNo: String?,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
    @ColumnInfo(name = "total_qty") val totalQty: Int,
    @ColumnInfo(name = "scanned_qty") val scannedQty: Int,
    @ColumnInfo(name = "boxed_qty") val boxedQty: Int,
)

data class PutAwayScanRow(
    val id: String,
    // Non-null in practice: rows reach the order through the receiving_invoice_items join.
    @ColumnInfo(name = "receiving_invoice_item_id") val receivingInvoiceItemId: String,
    val qty: Int,
    @ColumnInfo(name = "date_code") val dateCode: String?,
    @ColumnInfo(name = "lot_code") val lotCode: String?,
    val coo: String?,
    val cow: String?,
    @ColumnInfo(name = "shelf_box_id") val shelfBoxId: String?,
)

data class PutAwayBoxRow(
    val id: String,
    @ColumnInfo(name = "shelf_code") val shelfCode: String?,
    val zone: String?,
    val status: String,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "line_count") val lineCount: Int,
    @ColumnInfo(name = "total_qty") val totalQty: Int,
)

data class PutAwayBoxContentRow(
    @ColumnInfo(name = "box_id") val boxId: String,
    @ColumnInfo(name = "part_no") val partNo: String?,
    val qty: Int,
)

data class PutAwayScanItemRow(
    @ColumnInfo(name = "part_id") val partId: String,
    @ColumnInfo(name = "order_id") val orderId: String,
)

data class ShelfOptionRow(
    val code: String,
    val zone: String?,
)
