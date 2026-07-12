package com.docpal.warehousepda.data

import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.data.db.DetailItemFlatRow
import com.docpal.warehousepda.data.db.ReceivingItemMismatchEntity
import com.docpal.warehousepda.data.db.TransitionLogEntity
import com.docpal.warehousepda.domain.AllocationDistributor
import com.docpal.warehousepda.domain.Allocator
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.DisplayBox
import com.docpal.warehousepda.domain.model.DisplayPackage
import com.docpal.warehousepda.domain.model.MismatchInfo
import com.docpal.warehousepda.domain.model.PickingByReceivingRow
import com.docpal.warehousepda.domain.model.PickingItemLog
import com.docpal.warehousepda.domain.model.ReceivingInvoiceDetail
import com.docpal.warehousepda.domain.model.ReceivingItemDetail
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.domain.model.ReceivingOrderSummary
import com.docpal.warehousepda.ui.receiving.ReceivingDetailSource
import com.docpal.warehousepda.ui.receiving.ReceivingListSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID

/** Read model + clear/in-hand transitions for receiving orders. Mirrors the web adapter + db/receiving.ts. */
class ReceivingRepository(private val db: AppDatabase, private val allocator: Allocator) : ReceivingListSource, ReceivingDetailSource {

    private val dao get() = db.receivingDao()

    override suspend fun listOrders(filter: String): List<ReceivingOrderSummary> = withContext(Dispatchers.IO) {
        val rows = dao.listOrderRows(filter)
        val totals = dao.orderAllocationTotals().associate { (it.receivingOrderId to it.partId) to it.totalQty }
        val unboxed = dao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
        val links = dao.pendingPickingOrderLinks()
            .groupBy({ it.receivingOrderId }, { it.pickingOrderId })

        rows.groupBy { it.id }.map { (_, orderRows) ->
            val first = orderRows.first()
            val items = orderRows.filter { it.itemId != null }.map {
                AllocationDistributor.InvoiceItemRow(
                    id = it.itemId!!,
                    partId = it.partId!!,
                    receivingOrderId = first.id,
                    grossQty = it.grossQty ?: 0,
                    deliveryDate = first.deliveryDate,
                    invoiceNo = it.invoiceNo ?: "",
                    dateCode = it.dateCode,
                )
            }
            val availability = AllocationDistributor.distribute(items, totals, unboxed)
            val remaining = if (first.status == "in_hand") {
                availability.count { it.value.availableQty > 0 }
            } else 0
            ReceivingOrderSummary(
                id = first.id,
                refNo = first.refNo,
                status = first.status,
                deliveryDate = first.deliveryDate,
                supplierName = first.supplierName,
                remainingItems = remaining,
                pendingPickingOrders = links[first.id]?.distinct()?.size ?: 0,
            )
        }
    }

    override suspend fun getOrderDetail(orderId: String): ReceivingOrderDetail = withContext(Dispatchers.IO) {
        val order = dao.orderById(orderId)
            ?: throw LocalizedException("receiving_order_not_found")
        val supplierName = order.supplierId?.let { dao.supplierName(it) }
        val rows = dao.detailItemRows(orderId)
        val itemIds = rows.map { it.itemId }

        // Availability per item (allocated share) via the distributor.
        val availability = availabilityByItem(orderId, rows, order.deliveryDate)

        val mismatches = if (itemIds.isEmpty()) emptyList() else dao.activeMismatches(itemIds)
        val mismatchByItem = HashMap<String, ReceivingItemMismatchEntity>()
        for (m in mismatches) mismatchByItem.putIfAbsent(m.receivingInvoiceItemId, m)

        val invoices = rows.groupBy { it.invoiceId }.map { (invoiceId, invoiceRows) ->
            ReceivingInvoiceDetail(
                id = invoiceId,
                invoiceNo = invoiceRows.first().invoiceNo,
                items = invoiceRows.map { r ->
                    val m = mismatchByItem[r.itemId]
                    ReceivingItemDetail(
                        id = r.itemId, partId = r.partId, partNo = r.partNo,
                        poNo = r.poNo, poLine = r.poLine, qty = r.qty,
                        receivedQty = r.receivedQty, pickedQty = r.pickedQty, putAwayQty = r.putAwayQty,
                        boxId = r.boxId, dateCode = r.dateCode, lotCode = r.lotCode, coo = r.coo, cow = r.cow,
                        allocatedQty = availability[r.itemId]?.allocatedQty ?: 0,
                        mismatch = m?.let {
                            MismatchInfo(it.id, it.reason, it.mismatchQty, it.wrongPartNo, it.note,
                                it.status, it.effectiveReceivedQty, it.previousReceivedQty,
                                it.reportedBy, it.reportedAt)
                        },
                    )
                },
            )
        }

        val pickingRows = dao.pickingRowsByReceivingOrder(orderId).map {
            PickingByReceivingRow(
                it.pickingOrderId, it.pickingOrderRef, it.pickingOrderStatus, it.pickingOrderShipTo,
                it.pickingItemId, it.requiredQty, it.pickedQty, it.scannedQty, it.boxedQty,
                it.partId, it.partNo, it.shelfCode, it.boxId, it.dateCode, it.lotCode, it.coo, it.cow,
                it.allocatedQty, it.allocationId,
            )
        }
        val pickingItemIds = pickingRows.map { it.pickingItemId }.distinct()
        val pickingOrderIds = pickingRows.map { it.pickingOrderId }.distinct()

        val packagesByItem = if (pickingItemIds.isEmpty()) emptyMap() else
            dao.packagesByItemIds(pickingItemIds).map {
                DisplayPackage(it.id, it.pickingItemId, it.pickingOrderId, it.qty, it.shippingBoxId,
                    it.dateCode, it.lotCode, it.coo, it.cow, it.createdAt)
            }.groupBy { it.pickingItemId }

        val boxesByOrder = if (pickingOrderIds.isEmpty()) emptyMap() else
            dao.boxesByOrderIds(pickingOrderIds)
                .map { DisplayBox(it.id, it.pickingOrderId, it.status) }
                .groupBy { it.pickingOrderId ?: "" }

        val logs = if (pickingItemIds.isEmpty()) emptyMap() else
            dao.pickingItemLogs(pickingItemIds).map {
                PickingItemLog(it.id, it.entityId, it.fromState, it.toState, it.metadata, it.createdAt, it.actorName)
            }.groupBy { it.entityId }

        val remainingItems = if (order.status == "in_hand") {
            availability.count { it.value.availableQty > 0 }
        } else 0

        ReceivingOrderDetail(
            id = order.id, refNo = order.refNo, status = order.status,
            deliveryDate = order.deliveryDate, supplierName = supplierName,
            invoices = invoices, remainingItems = remainingItems,
            pickingRows = pickingRows, packagesByItem = packagesByItem,
            boxesByOrder = boxesByOrder, transitionLogs = logs,
        )
    }

    /** available = received - picked - put_away - allocated - unboxed scans, per item. Used by clear/in-hand. */
    internal fun availableQtyByItem(orderId: String): Map<String, Int> {
        val order = dao.orderById(orderId) ?: return emptyMap()
        val rows = dao.detailItemRows(orderId)
        return availabilityByItem(orderId, rows, order.deliveryDate)
            .mapValues { it.value.availableQty }
    }

    private fun availabilityByItem(
        orderId: String,
        rows: List<DetailItemFlatRow>,
        deliveryDate: Long?,
    ): Map<String, AllocationDistributor.ItemAvailability> {
        val totals = dao.orderAllocationTotals().associate { (it.receivingOrderId to it.partId) to it.totalQty }
        val unboxed = dao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
        val items = rows.map {
            AllocationDistributor.InvoiceItemRow(
                id = it.itemId, partId = it.partId, receivingOrderId = orderId,
                grossQty = it.receivedQty - it.pickedQty - it.putAwayQty,
                deliveryDate = deliveryDate,
                invoiceNo = it.invoiceNo,
                dateCode = it.dateCode,
            )
        }
        return AllocationDistributor.distribute(items, totals, unboxed)
    }

    /** Port of db/receiving.ts confirmReceivingOrderArrived. Allocation runs AFTER the transaction, best-effort. */
    override suspend fun confirmArrived(orderId: String, actorId: String) = withContext(Dispatchers.IO) {
        val now = System.currentTimeMillis()
        db.runInTransaction {
            val order = dao.orderById(orderId) ?: throw LocalizedException("receiving_order_not_found")
            if (order.status != "pending") {
                throw LocalizedException("receiving_order_already_status", mapOf("status" to order.status))
            }
            dao.markOrderArrived(orderId, actorId, now)
            val invoices = dao.invoicesOfOrder(orderId)
            val items = if (invoices.isEmpty()) emptyList() else dao.itemsOfInvoices(invoices.map { it.id })
            val mismatches = if (items.isEmpty()) emptyList() else dao.activeMismatches(items.map { it.id })
            val mismatchByItem = HashMap<String, ReceivingItemMismatchEntity>()
            for (m in mismatches) mismatchByItem.putIfAbsent(m.receivingInvoiceItemId, m)
            for (item in items) {
                val qtyToReceive = mismatchByItem[item.id]?.effectiveReceivedQty ?: item.qty
                if (qtyToReceive <= 0) continue // web skips writes when <= 0
                dao.updateItemReceivedQty(item.id, qtyToReceive)
            }
            dao.insertTransitionLog(
                TransitionLogEntity(
                    id = UUID.randomUUID().toString(),
                    entityType = "receiving_order", entityId = orderId,
                    fromState = order.status, toState = "in_hand",
                    actorId = actorId, metadata = null, createdAt = now,
                )
            )
        }
        allocator.allocatePendingPickingOrders()
    }

    /** Mirrors web tryMarkReceivingOrderClear: in_hand → clear when every item's available <= 0. */
    fun tryMarkClear(orderId: String, actorId: String) {
        db.runInTransaction {
            val order = dao.orderById(orderId) ?: return@runInTransaction
            if (order.status != "in_hand") return@runInTransaction
            val invoices = dao.invoicesOfOrder(orderId)
            val items = if (invoices.isEmpty()) emptyList() else dao.itemsOfInvoices(invoices.map { it.id })
            if (items.isEmpty()) return@runInTransaction
            val available = availableQtyByItem(orderId)
            if (items.any { (available[it.id] ?: 0) > 0 }) return@runInTransaction
            val now = System.currentTimeMillis()
            dao.updateOrderStatus(orderId, "clear", now)
            dao.insertTransitionLog(
                TransitionLogEntity(
                    id = UUID.randomUUID().toString(),
                    entityType = "receiving_order", entityId = orderId,
                    fromState = order.status, toState = "clear",
                    actorId = actorId, metadata = null, createdAt = now,
                )
            )
        }
    }

    /** Mirrors web tryMarkReceivingOrderInHand: clear → in_hand when any item regains availability. */
    fun tryMarkInHand(orderId: String, actorId: String) {
        db.runInTransaction {
            val order = dao.orderById(orderId) ?: return@runInTransaction
            if (order.status != "clear") return@runInTransaction
            val invoices = dao.invoicesOfOrder(orderId)
            val items = if (invoices.isEmpty()) emptyList() else dao.itemsOfInvoices(invoices.map { it.id })
            if (items.isEmpty()) return@runInTransaction
            val available = availableQtyByItem(orderId)
            if (items.none { (available[it.id] ?: 0) > 0 }) return@runInTransaction
            val now = System.currentTimeMillis()
            dao.updateOrderStatus(orderId, "in_hand", now)
            dao.insertTransitionLog(
                TransitionLogEntity(
                    id = UUID.randomUUID().toString(),
                    entityType = "receiving_order", entityId = orderId,
                    fromState = order.status, toState = "in_hand",
                    actorId = actorId, metadata = null, createdAt = now,
                )
            )
        }
    }
}
