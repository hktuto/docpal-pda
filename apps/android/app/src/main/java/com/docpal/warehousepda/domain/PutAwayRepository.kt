package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.ReceivingAvailability
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.model.PutAwayBoxContent
import com.docpal.warehousepda.domain.model.PutAwayBoxDetail
import com.docpal.warehousepda.domain.model.PutAwayCandidate
import com.docpal.warehousepda.domain.model.PutAwayDetail
import com.docpal.warehousepda.domain.model.PutAwayLotDetail
import com.docpal.warehousepda.domain.model.PutAwayOrderHeader
import com.docpal.warehousepda.domain.model.PutAwayScanDetail
import com.docpal.warehousepda.domain.model.ShelfOption
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Put-away read model. Port of web getPutAwayCandidates (apps/web/db/putAway.ts):
 * in-hand receiving orders kept when SUM(available_qty) > 0 OR any unboxed put-away
 * scan exists (the web HAVING clause). getPutAwayDetail assembles the detail page
 * (header, lots, scans, boxes, shelves) from the flat DAO rows. Per-item availability
 * reuses [ReceivingAvailability] — the same AllocationDistributor math as the receiving
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

    /**
     * Put-away detail (web put-away detail page): header + lots + scans + boxes + shelf
     * options. Lots reuse [ReceivingAvailability] for the live available qty and apply the
     * web getPutAwayLots HAVING (available > 0 OR unboxed scans > 0); like the web, the
     * lots panel is empty unless the order is in_hand (shows common_no_lots).
     */
    suspend fun getPutAwayDetail(orderId: String): PutAwayDetail? = withContext(Dispatchers.IO) {
        val headerRow = putAwayDao.orderHeaderRow(orderId) ?: return@withContext null
        val header = PutAwayOrderHeader(
            id = headerRow.id,
            refNo = headerRow.refNo,
            status = headerRow.status,
            supplierName = headerRow.supplierName,
            supplierCode = headerRow.supplierCode,
            deliveryDate = headerRow.deliveryDate,
        )
        val lots = if (header.status == "in_hand") {
            val itemRows = receivingDao.detailItemRows(orderId)
            val availability =
                ReceivingAvailability.byItem(receivingDao, orderId, itemRows, header.deliveryDate)
            putAwayDao.lotRows(orderId).mapNotNull { row ->
                // Per-item clamp >= 0, same as listCandidates: fully allocated + unboxed-scanned
                // items go negative in the distributor math but display as 0.
                val availableQty = maxOf(0, availability[row.itemId]?.availableQty ?: 0)
                val unboxedQty = row.scannedQty - row.boxedQty
                // Web HAVING: available > 0 OR unboxed scans > 0.
                if (availableQty <= 0 && unboxedQty <= 0) return@mapNotNull null
                PutAwayLotDetail(
                    receivingInvoiceItemId = row.itemId,
                    partNo = row.partNo,
                    dateCode = row.dateCode,
                    lotCode = row.lotCode,
                    coo = row.coo,
                    cow = row.cow,
                    totalQty = row.totalQty,
                    availableQty = availableQty,
                    scannedQty = row.scannedQty,
                    boxedQty = row.boxedQty,
                )
            }
        } else emptyList()
        val scans = putAwayDao.scanRows(orderId).map { row ->
            PutAwayScanDetail(
                id = row.id,
                receivingInvoiceItemId = row.receivingInvoiceItemId,
                qty = row.qty,
                dateCode = row.dateCode,
                lotCode = row.lotCode,
                coo = row.coo,
                cow = row.cow,
                shelfBoxId = row.shelfBoxId,
            )
        }
        val contentsByBox = putAwayDao.boxContentRows(orderId)
            .groupBy { it.boxId }
            .mapValues { (_, rows) -> rows.map { PutAwayBoxContent(it.partNo, it.qty) } }
        val boxes = putAwayDao.boxRows(orderId).map { row ->
            PutAwayBoxDetail(
                id = row.id,
                shelfCode = row.shelfCode,
                zone = row.zone,
                status = row.status,
                createdAt = row.createdAt,
                lineCount = row.lineCount,
                totalQty = row.totalQty,
                contents = contentsByBox[row.id] ?: emptyList(),
            )
        }
        val shelves = putAwayDao.shelfOptionRows().map { ShelfOption(it.code, it.zone) }
        PutAwayDetail(header = header, lots = lots, scans = scans, boxes = boxes, shelves = shelves)
    }
}
