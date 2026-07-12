package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Query

@Dao
interface PutAwayDao {

    /**
     * Put-away list base rows (web listPutAwayCandidates, putAway.ts): in-hand receiving
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
}

data class InHandOrderRow(
    val id: String,
    @ColumnInfo(name = "ref_no") val refNo: String,
    val status: String,
    @ColumnInfo(name = "delivery_date") val deliveryDate: Long?,
    @ColumnInfo(name = "supplier_name") val supplierName: String?,
)
