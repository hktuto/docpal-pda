package com.docpal.warehousepda.data

import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.AllocationDistributor
import com.docpal.warehousepda.domain.scan.QrParser
import com.docpal.warehousepda.domain.scan.ScanMatcher
import com.docpal.warehousepda.domain.scan.ScanPrimitives
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Candidate queries for scan matching (port of db/ocrPicking.ts find functions). */
class ScanRepository(private val db: AppDatabase) {

    private val scanDao get() = db.scanDao()
    private val receivingDao get() = db.receivingDao()

    /** Supplier QR templates (web getSuppliersWithQrTemplates). */
    suspend fun supplierQrTemplates(): List<QrParser.SupplierQrcodeTemplate> = withContext(Dispatchers.IO) {
        scanDao.supplierQrTemplates().map {
            QrParser.SupplierQrcodeTemplate(it.code, it.qrcodeTemplate, it.qrcodeQtyEncoding)
        }
    }

    suspend fun findReceivingCandidates(
        receivingOrderId: String, normalizedPartNo: String, qty: Int,
    ): List<ScanMatcher.ReceivingCandidate> = withContext(Dispatchers.IO) {
        val rows = scanDao.receivingCandidateRows(receivingOrderId)
        val order = receivingDao.orderById(receivingOrderId) ?: return@withContext emptyList()
        val totals = receivingDao.orderAllocationTotals()
            .associate { (it.receivingOrderId to it.partId) to it.totalQty }
        val unboxed = receivingDao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
        val distributorItems = rows.map {
            AllocationDistributor.InvoiceItemRow(
                id = it.receivingInvoiceItemId, partId = it.partId,
                receivingOrderId = receivingOrderId,
                grossQty = it.receivedQty - it.pickedQty - it.putAwayQty,
                deliveryDate = order.deliveryDate, invoiceNo = it.invoiceNo,
                dateCode = it.dateCode,
            )
        }
        val availability = AllocationDistributor.distribute(distributorItems, totals, unboxed)
        rows.mapNotNull { row ->
            if (ScanPrimitives.normalize(row.partNo) != normalizedPartNo) return@mapNotNull null
            val available = availability[row.receivingInvoiceItemId]?.availableQty ?: return@mapNotNull null
            if (available < qty) return@mapNotNull null
            ScanMatcher.ReceivingCandidate(
                receivingInvoiceItemId = row.receivingInvoiceItemId,
                partId = row.partId, partNo = row.partNo,
                dateCode = row.dateCode?.let { ScanPrimitives.normalizeCode(it) },
                lotCode = row.lotCode?.let { ScanPrimitives.normalizeCode(it) },
                coo = row.coo?.let { ScanPrimitives.normalize(it) },
                cow = row.cow?.let { ScanPrimitives.normalize(it) },
                availableQty = available,
            )
        }.sortedWith(compareBy({ it.dateCode == null }, { it.dateCode ?: "" }, { it.lotCode == null }, { it.lotCode ?: "" }))
    }

    suspend fun findPickingCandidates(
        receivingOrderId: String, partId: String,
    ): List<ScanMatcher.PickingCandidate> = withContext(Dispatchers.IO) {
        scanDao.pickingCandidateRows(receivingOrderId, partId).mapNotNull { row ->
            val remaining = row.requiredQty - row.pickedQty - row.scannedNotBoxedQty
            if (remaining <= 0) return@mapNotNull null
            ScanMatcher.PickingCandidate(
                pickingOrderId = row.pickingOrderId,
                pickingOrderRefNo = row.pickingOrderRefNo,
                pickingItemId = row.pickingItemId,
                partId = row.partId, shipTo = row.shipTo,
                requiredQty = row.requiredQty, pickedQty = row.pickedQty,
                remainingQty = remaining,
            )
        }
    }
}
