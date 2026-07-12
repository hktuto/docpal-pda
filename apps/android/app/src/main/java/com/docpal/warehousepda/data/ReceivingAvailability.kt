package com.docpal.warehousepda.data

import com.docpal.warehousepda.data.db.DetailItemFlatRow
import com.docpal.warehousepda.data.db.ReceivingDao
import com.docpal.warehousepda.domain.AllocationDistributor

/**
 * Shared per-item receiving availability (the web `allocationsCte` computation):
 * invoice-item rows + order-level allocation totals + unboxed put-away scan totals
 * → per-item breakdown via [AllocationDistributor.distribute].
 *
 * Extracted verbatim from ReceivingRepository.availabilityByItem so the put-away
 * screens (PutAwayRepository, phase 3) reuse the exact same math — do not duplicate
 * the distribution logic.
 */
internal object ReceivingAvailability {

    fun byItem(
        dao: ReceivingDao,
        orderId: String,
        rows: List<DetailItemFlatRow>,
        deliveryDate: Long?,
    ): Map<String, AllocationDistributor.ItemAvailability> {
        val totals = dao.orderAllocationTotals().associate { (it.receivingOrderId to it.partId) to it.totalQty }
        val unboxed = dao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
        val items = rows.map {
            AllocationDistributor.InvoiceItemRow(
                id = it.itemId,
                partId = it.partId,
                receivingOrderId = orderId,
                grossQty = it.receivedQty - it.pickedQty - it.putAwayQty,
                deliveryDate = deliveryDate,
                invoiceNo = it.invoiceNo,
                dateCode = it.dateCode,
            )
        }
        return AllocationDistributor.distribute(items, totals, unboxed)
    }
}
