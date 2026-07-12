package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.ReceivingAvailability
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.model.PutAwayCandidate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Put-away candidate list. Port of web listPutAwayCandidates (apps/web/db/putAway.ts):
 * in-hand receiving orders kept when SUM(available_qty) > 0 OR any unboxed put-away
 * scan exists (the web HAVING clause). Per-item availability reuses
 * [ReceivingAvailability] — the same AllocationDistributor math as the receiving
 * screens; do not duplicate it. Threading matches the other repositories: suspend
 * entry points wrap plain blocking Room calls in withContext(Dispatchers.IO).
 */
class PutAwayRepository(private val db: AppDatabase) {

    private val putAwayDao get() = db.putAwayDao()
    private val receivingDao get() = db.receivingDao()

    suspend fun listCandidates(): List<PutAwayCandidate> = withContext(Dispatchers.IO) {
        putAwayDao.inHandOrderRows().mapNotNull { row ->
            val itemRows = receivingDao.detailItemRows(row.id)
            val availability = ReceivingAvailability.byItem(receivingDao, row.id, itemRows, row.deliveryDate)
            // Per-item clamp >= 0: the distributor itself does not clamp, and unboxed
            // scans can push an item negative (gross - allocated - unboxed < 0). Such
            // an item always has unboxedQty > 0, so the web HAVING result (SUM > 0 OR
            // unboxed > 0) is preserved while the displayed total never goes negative.
            val availableQty = itemRows.sumOf { maxOf(0, availability[it.itemId]?.availableQty ?: 0) }
            val unboxedQty = itemRows.sumOf { availability[it.itemId]?.unboxedScannedQty ?: 0 }
            if (availableQty <= 0 && unboxedQty <= 0) return@mapNotNull null
            PutAwayCandidate(
                orderId = row.id,
                refNo = row.refNo,
                status = row.status,
                supplierName = row.supplierName,
                availableQty = availableQty,
            )
        }
    }
}
