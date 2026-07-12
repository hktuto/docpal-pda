package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.ReceivingRepository
import com.docpal.warehousepda.data.db.AllocationEntity
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.data.db.InventoryLotEntity
import com.docpal.warehousepda.data.db.InventoryLotSourceEntity
import com.docpal.warehousepda.data.db.MeasuringTaskEntity
import com.docpal.warehousepda.data.db.PickingPackageEntity
import com.docpal.warehousepda.data.db.ShippingBoxEntity
import com.docpal.warehousepda.data.db.TransitionLogEntity
import com.docpal.warehousepda.domain.model.PickingIssueInput
import com.docpal.warehousepda.domain.model.PickingOrderSummary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.Calendar
import java.util.Locale
import java.util.UUID

/**
 * Scan-to-pick and shipping-box operations. Function-by-function port of
 * apps/web/db/ocrPicking.ts (applyOcrPick) and apps/web/db/picking.ts
 * (reportPickingOrderIssues, scanAllocationToPackage, removeScannedPackage, materializeReceivingAllocation,
 * createShippingBoxForPickingOrder, addPackageToBox, addAllUnboxedPackagesToBox,
 * removePackageFromBox, maybeAutoFinishPickingOrder, refreshPickingItemPickedQty),
 * keeping the web's error keys and write order.
 */
class PickingRepository(
    private val db: AppDatabase,
    private val receivingRepository: ReceivingRepository,
) {

    private val pickingDao get() = db.pickingDao()
    private val receivingDao get() = db.receivingDao()

    /** Picking list (web pgliteWarehouse listOrders): all orders, finished last, with item qty totals. */
    suspend fun listOrders(): List<PickingOrderSummary> = withContext(Dispatchers.IO) {
        pickingDao.pickingOrderSummaryRows().map {
            PickingOrderSummary(
                id = it.id,
                refNo = it.refNo,
                status = it.status,
                deliveryDate = it.deliveryDate,
                supplierName = it.supplierName,
                shipTo = it.shipTo,
                totalQty = it.totalQty,
            )
        }
    }

    /**
     * Port of web reportPickingOrderIssues (picking.ts): batch-mark pending/picking orders as
     * issue with a transition log each. Finished/issue orders are silently skipped.
     * Returns (reported, skipped).
     */
    suspend fun reportPickingOrderIssues(
        entries: List<Pair<String, String?>>,
        input: PickingIssueInput,
        actorId: String,
    ): Pair<Int, Int> = withContext(Dispatchers.IO) {
        if (entries.isEmpty()) throw LocalizedException("no_orders_selected")
        if (input.reason == "merge" && entries.size < 2) {
            throw LocalizedException("select_at_least_two_orders_to_merge")
        }
        if (input.reason == "insufficient_stock" && (input.qty == null || input.qty < 0)) {
            throw LocalizedException("actual_quantity_required")
        }
        if (input.reason == "cannot_divide" && (input.packSize == null || input.packSize <= 0)) {
            throw LocalizedException("pack_size_required")
        }

        val orderIds = entries.map { it.first }
        var result = 0 to 0
        db.runInTransaction {
            val orders = pickingDao.pickingOrdersByIds(orderIds)
            val reportable = orders.filter { it.status == "pending" || it.status == "picking" }
            if (reportable.isEmpty()) throw LocalizedException("no_reportable_orders_selected")

            val remarkByOrderId = entries.associate { (id, remark) ->
                id to remark?.trim()?.takeIf { it.isNotEmpty() }
            }
            val note = input.note?.trim()?.takeIf { it.isNotEmpty() }
            val now = System.currentTimeMillis()

            for (order in reportable) {
                val totalQty = pickingDao.totalQtyOfOrder(order.id)
                if (input.reason == "insufficient_stock" && input.qty!! >= totalQty) {
                    throw LocalizedException(
                        "actual_qty_must_be_less_than_requested",
                        mapOf("ref_no" to order.refNo),
                    )
                }
                val remark = remarkByOrderId[order.id]
                pickingDao.markPickingOrderIssue(
                    id = order.id,
                    reason = input.reason,
                    qty = if (input.reason == "insufficient_stock") input.qty else null,
                    packSize = if (input.reason == "cannot_divide") input.packSize else null,
                    note = note,
                    remark = remark,
                    now = now,
                    actorId = actorId,
                )
                pickingDao.insertLog(
                    TransitionLogEntity(
                        id = UUID.randomUUID().toString(),
                        entityType = "picking_order", entityId = order.id,
                        fromState = order.status, toState = "issue", actorId = actorId,
                        // Web JSON.stringify drops undefined; mirror by only putting non-null
                        // values. Like the web, metadata keeps the raw note (column is trimmed).
                        metadata = JSONObject().apply {
                            put("reason", input.reason)
                            input.qty?.let { put("qty", it) }
                            input.packSize?.let { put("packSize", it) }
                            input.note?.let { put("note", it) }
                            remark?.let { put("remark", it) }
                        }.toString(),
                        createdAt = now,
                    )
                )
            }
            result = reportable.size to (orderIds.size - reportable.size)
        }
        result
    }

    /** Port of web applyOcrPick (ocrPicking.ts): top up + consume coarse allocation, build lot, scan into one package. */
    suspend fun applyOcrPick(
        receivingOrderId: String,
        pickingItemId: String,
        qty: Int,
        dateCode: String?,
        lotCode: String?,
        coo: String?,
        cow: String?,
        actorId: String,
    ) = withContext(Dispatchers.IO) {
        if (qty <= 0) throw LocalizedException("qty_must_be_positive_integer")
        if (actorId.isEmpty()) throw LocalizedException("actor_required")
        db.runInTransaction {
            val ro = receivingDao.orderById(receivingOrderId)
                ?: throw LocalizedException("receiving_order_not_found")
            if (ro.status != "in_hand") throw LocalizedException("receiving_order_not_in_hand")
            val item = pickingDao.pickingItemById(pickingItemId)
                ?: throw LocalizedException("picking_item_not_found")
            if (pickingDao.partInReceivingOrder(receivingOrderId, item.partId) == null) {
                throw LocalizedException("receiving_picking_part_mismatch")
            }
            val scannedNotBoxed = pickingDao.unboxedPackageQty(pickingItemId)
            val remaining = item.qty - item.pickedQty - scannedNotBoxed
            if (qty > remaining) throw LocalizedException("quantity_exceeds_picking_need")

            val existing = pickingDao.coarseAllocations(receivingOrderId, pickingItemId)
            val existingTotal = existing.sumOf { it.qty }

            val availability =
                pickingDao.receivingAvailabilityForScan(receivingOrderId, item.partId, pickingItemId)
            val availableForScan =
                availability.physicalQty - availability.reservedByOthers - availability.unboxedQty
            if (qty > availableForScan) throw LocalizedException("quantity_not_available_receiving")

            val left = maxOf(0, qty - existingTotal)
            if (left > 0) {
                val unallocatedDemand = item.qty - item.pickedQty - item.allocatedQty - scannedNotBoxed
                if (left > unallocatedDemand) {
                    throw LocalizedException("quantity_exceeds_unallocated_picking_need")
                }
                pickingDao.insertAllocation(
                    AllocationEntity(
                        id = UUID.randomUUID().toString(),
                        pickingItemId = pickingItemId, inventoryLotId = null,
                        receivingOrderId = receivingOrderId, qty = left, remark = null,
                    )
                )
                pickingDao.increaseItemAllocated(pickingItemId, left)
            }

            // FIFO split across invoice items, excluding this picking item's own allocation
            // (web allocationsCte(pickingItemId)): recompute distributor without this item's totals.
            val fifoRows = pickingDao.fifoInvoiceItemsForScan(receivingOrderId, item.partId)
            val totalsExcludingSelf = receivingDao.orderAllocationTotals()
                .filter { it.receivingOrderId == receivingOrderId && it.partId == item.partId }
                .associate { (it.receivingOrderId to it.partId) to it.totalQty }
                .toMutableMap()
            val selfKey = receivingOrderId to item.partId
            val selfCoarse = pickingDao.coarseAllocations(receivingOrderId, pickingItemId).sumOf { it.qty }
            totalsExcludingSelf[selfKey] = (totalsExcludingSelf[selfKey] ?: 0) - selfCoarse
            val unboxed = receivingDao.unboxedPutAwayScanTotals().associate { it.itemId to it.qty }
            val distributorItems = fifoRows.map {
                AllocationDistributor.InvoiceItemRow(
                    id = it.itemId, partId = item.partId, receivingOrderId = receivingOrderId,
                    grossQty = it.receivedQty - it.pickedQty - it.putAwayQty,
                    deliveryDate = ro.deliveryDate, invoiceNo = it.invoiceNo, dateCode = it.dateCode,
                )
            }
            val availabilityByItem = AllocationDistributor.distribute(distributorItems, totalsExcludingSelf, unboxed)

            val portions = ArrayList<Pair<String, Int>>()
            var remainingScan = qty
            for (row in fifoRows) {
                if (remainingScan <= 0) break
                val available = availabilityByItem[row.itemId]?.availableQty ?: 0
                if (available <= 0) continue
                val use = minOf(remainingScan, available)
                portions.add(row.itemId to use)
                remainingScan -= use
            }
            if (remainingScan > 0) throw LocalizedException("quantity_not_available_receiving")

            // Consume coarse allocations FIFO by id.
            var toConsume = qty
            val reloaded = pickingDao.coarseAllocations(receivingOrderId, pickingItemId)
            var index = 0
            while (toConsume > 0) {
                val allocation = reloaded.getOrNull(index) ?: throw LocalizedException("allocation_not_found")
                val take = minOf(toConsume, allocation.qty)
                if (take < allocation.qty) pickingDao.decreaseAllocationQty(allocation.id, take)
                else pickingDao.deleteAllocation(allocation.id)
                toConsume -= take
                index++
            }

            // One receiving-area lot + sources + lot allocation, then scan into one package.
            val lotId = UUID.randomUUID().toString()
            pickingDao.insertLot(
                InventoryLotEntity(
                    id = lotId, partId = item.partId, dateCode = dateCode, lotCode = lotCode,
                    coo = coo, cow = cow, shelfCode = null, boxId = null,
                    totalQty = qty, allocatedQty = qty, availableQty = 0,
                )
            )
            for ((itemId, portionQty) in portions) {
                pickingDao.insertLotSource(
                    InventoryLotSourceEntity(
                        id = UUID.randomUUID().toString(),
                        inventoryLotId = lotId, receivingInvoiceItemId = itemId, qty = portionQty,
                    )
                )
            }
            val lotAllocationId = UUID.randomUUID().toString()
            pickingDao.insertAllocation(
                AllocationEntity(
                    id = lotAllocationId, pickingItemId = pickingItemId,
                    inventoryLotId = lotId, receivingOrderId = null, qty = qty, remark = null,
                )
            )
            scanAllocationToPackageInternal(lotAllocationId, qty, actorId)
        }
        Unit
    }

    /** Port of web materializeReceivingAllocation: coarse allocation -> receiving-area lot + sources + lot allocation (no scan). */
    suspend fun materializeReceivingAllocation(
        allocationId: String,
        qty: Int,
        dateCode: String?,
        lotCode: String?,
        coo: String?,
        cow: String?,
        receivingInvoiceItemId: String,
    ): String = withContext(Dispatchers.IO) {
        var resultId: String? = null
        db.runInTransaction {
            val allocation = pickingDao.allocationById(allocationId)
                ?: throw LocalizedException("allocation_not_found")
            if (allocation.receivingOrderId == null) {
                throw LocalizedException("allocation_not_against_receiving_order")
            }
            if (qty <= 0 || qty > allocation.qty) {
                throw LocalizedException("invalid_materialize_quantity")
            }
            val invoiceItem = receivingDao.itemById(receivingInvoiceItemId)
                ?: throw LocalizedException("receiving_invoice_item_not_found")

            // Always a dedicated receiving-area lot so scanAllocationToPackage source
            // accounting stays tied to the original invoice item.
            val lotId = UUID.randomUUID().toString()
            pickingDao.insertLot(
                InventoryLotEntity(
                    id = lotId, partId = invoiceItem.partId, dateCode = dateCode, lotCode = lotCode,
                    coo = coo, cow = cow, shelfCode = null, boxId = null,
                    totalQty = qty, allocatedQty = qty, availableQty = 0,
                )
            )
            pickingDao.insertLotSource(
                InventoryLotSourceEntity(
                    id = UUID.randomUUID().toString(),
                    inventoryLotId = lotId, receivingInvoiceItemId = invoiceItem.id, qty = qty,
                )
            )

            resultId = if (qty < allocation.qty) {
                // Reduce the original allocation to the remainder; new lot allocation for qty.
                pickingDao.decreaseAllocationQty(allocationId, qty)
                val newAllocationId = UUID.randomUUID().toString()
                pickingDao.insertAllocation(
                    AllocationEntity(
                        id = newAllocationId, pickingItemId = allocation.pickingItemId,
                        inventoryLotId = lotId, receivingOrderId = null, qty = qty, remark = null,
                    )
                )
                newAllocationId
            } else {
                // Move the whole allocation onto the new lot.
                pickingDao.moveAllocationToLot(allocationId, lotId)
                allocationId
            }
        }
        resultId!!
    }

    /** Port of web scanAllocationToPackage (standalone transaction). Returns the new package id. */
    suspend fun scanAllocationToPackage(allocationId: String, qty: Int, actorId: String): String =
        withContext(Dispatchers.IO) {
            var packageId: String? = null
            db.runInTransaction { packageId = scanAllocationToPackageInternal(allocationId, qty, actorId) }
            packageId!!
        }

    /** Web scanAllocationToPackage; tx-internal (also called standalone via public wrapper). */
    internal fun scanAllocationToPackageInternal(allocationId: String, qty: Int, actorId: String): String {
        val allocation = pickingDao.allocationById(allocationId) ?: throw LocalizedException("allocation_not_found")
        if (qty <= 0 || qty > allocation.qty) throw LocalizedException("invalid_scan_quantity")
        val item = pickingDao.pickingItemById(allocation.pickingItemId)
            ?: throw LocalizedException("picking_item_not_found")
        val order = pickingDao.pickingOrderById(item.pickingOrderId)
        if (order?.status == "issue") throw LocalizedException("picking_order_has_open_issue")
        val scannedNotBoxed = pickingDao.unboxedPackageQty(item.id)
        if (item.pickedQty + scannedNotBoxed + qty > item.qty) {
            throw LocalizedException("scan_quantity_exceeds_required")
        }
        val lotId = allocation.inventoryLotId ?: throw LocalizedException("allocation_has_no_source")
        val lot = pickingDao.lotById(lotId) ?: throw LocalizedException("inventory_lot_not_found")
        if (lot.allocatedQty < qty) throw LocalizedException("insufficient_allocated_quantity")
        if (lot.totalQty < qty) throw LocalizedException("insufficient_lot_quantity")
        pickingDao.decreaseLotQtys(lot.id, qty)

        if (lot.shelfCode == null && lot.boxId == null) {
            val sources = pickingDao.lotSources(lot.id)
            val totalSourceQty = sources.sumOf { it.qty }
            if (totalSourceQty < qty) throw LocalizedException("insufficient_source_quantity")
            var remaining = qty
            val affectedItemIds = ArrayList<String>()
            for (source in sources) {
                if (remaining <= 0) break
                val apply = minOf(remaining, source.qty)
                pickingDao.increaseItemPickedQty(source.receivingInvoiceItemId, apply)
                pickingDao.decreaseLotSourceQty(source.id, apply)
                affectedItemIds.add(source.receivingInvoiceItemId)
                remaining -= apply
            }
            val affectedOrderIds = affectedItemIds.mapNotNull { pickingDao.orderIdOfInvoiceItem(it) }.distinct()
            for (orderId in affectedOrderIds) receivingRepository.tryMarkClear(orderId, actorId)
        }

        // Reduce allocation instead of deleting so the receiving-side picking view
        // can keep showing the historical link after a full scan.
        pickingDao.decreaseAllocationQty(allocationId, qty)
        pickingDao.decreaseItemAllocated(item.id, qty)

        val packageId = UUID.randomUUID().toString()
        pickingDao.insertPackage(
            PickingPackageEntity(
                id = packageId, pickingItemId = item.id, pickingOrderId = item.pickingOrderId,
                sourceType = "inventory_lot", sourceId = lot.id, qty = qty,
                shippingBoxId = null, dateCode = lot.dateCode, lotCode = lot.lotCode,
                coo = lot.coo, cow = lot.cow, verified = false,
                createdAt = System.currentTimeMillis(),
            )
        )
        pickingDao.insertLog(
            TransitionLogEntity(
                id = UUID.randomUUID().toString(),
                entityType = "picking_item", entityId = item.id,
                fromState = "picking", toState = "scanned", actorId = actorId,
                metadata = JSONObject().apply {
                    put("allocationId", allocationId); put("qty", qty); put("packageId", packageId)
                }.toString(),
                createdAt = System.currentTimeMillis(),
            )
        )
        return packageId
    }

    /** Port of web removeScannedPackage: reverses scanAllocationToPackage. */
    suspend fun removeScannedPackage(packageId: String, actorId: String) = withContext(Dispatchers.IO) {
        if (actorId.isEmpty()) throw LocalizedException("actor_required")
        db.runInTransaction {
            val pkg = pickingDao.packageById(packageId) ?: throw LocalizedException("package_not_found")
            if (pkg.shippingBoxId != null) throw LocalizedException("package_already_in_box")

            val item = pickingDao.pickingItemById(pkg.pickingItemId)
                ?: throw LocalizedException("picking_item_not_found")
            val order = pickingDao.pickingOrderById(item.pickingOrderId)
            if (order?.status == "issue") throw LocalizedException("picking_order_has_open_issue")

            val qty = pkg.qty

            if (pkg.sourceType == "inventory_lot") {
                val lot = pickingDao.lotById(pkg.sourceId) ?: throw LocalizedException("inventory_lot_not_found")
                pickingDao.increaseLotQtys(lot.id, qty)

                if (lot.shelfCode == null && lot.boxId == null) {
                    // Ported as written from the web: restores `remaining` into the first
                    // source row (the loop sets remaining = 0 after the first iteration).
                    var remaining = qty
                    for (source in pickingDao.lotSources(lot.id)) {
                        if (remaining <= 0) break
                        pickingDao.increaseLotSourceQty(source.id, remaining)
                        pickingDao.decreaseItemPickedQty(source.receivingInvoiceItemId, remaining)
                        remaining = 0
                    }
                }

                val allocation = pickingDao.allocationByLotAndItem(lot.id, item.id)
                if (allocation != null) {
                    pickingDao.increaseAllocationQty(allocation.id, qty)
                } else {
                    pickingDao.insertAllocation(
                        AllocationEntity(
                            id = UUID.randomUUID().toString(),
                            pickingItemId = item.id, inventoryLotId = lot.id,
                            receivingOrderId = null, qty = qty, remark = null,
                        )
                    )
                }
            } else {
                // The web also has a receiving_invoice_item branch, but no package with that
                // source type can exist: scanAllocationToPackage only creates inventory_lot
                // packages (allocation_has_no_source otherwise).
                throw LocalizedException("unknown_package_source_type")
            }

            pickingDao.increaseItemAllocated(item.id, qty)
            pickingDao.deletePackage(packageId)

            pickingDao.insertLog(
                TransitionLogEntity(
                    id = UUID.randomUUID().toString(),
                    entityType = "picking_item", entityId = item.id,
                    fromState = "scanned", toState = "removed", actorId = actorId,
                    metadata = JSONObject().apply {
                        put("packageId", packageId); put("qty", qty)
                    }.toString(),
                    createdAt = System.currentTimeMillis(),
                )
            )

            refreshPickingItemPickedQty(item.id)

            // tryMarkInHand via lot source -> invoice -> receiving order.
            val firstSource = pickingDao.lotSources(pkg.sourceId).firstOrNull()
            val receivingOrderId = firstSource?.let { pickingDao.orderIdOfInvoiceItem(it.receivingInvoiceItemId) }
            if (receivingOrderId != null) receivingRepository.tryMarkInHand(receivingOrderId, actorId)
        }
        Unit
    }

    /** Port of web createShippingBoxForPickingOrder. Returns the generated box id. */
    suspend fun createShippingBoxForPickingOrder(pickingOrderId: String, actorId: String): String =
        withContext(Dispatchers.IO) {
            var boxId: String? = null
            db.runInTransaction {
                val now = System.currentTimeMillis()
                val order = pickingDao.pickingOrderById(pickingOrderId)
                    ?: throw LocalizedException("picking_order_not_found")
                if (order.status == "finished") throw LocalizedException("picking_order_already_finished")
                if (order.status == "issue") throw LocalizedException("picking_order_has_open_issue")

                val prefix = locationBoxIdPrefix("BOX", "HK1")
                val generatedId = generateLocationBoxId(prefix, pickingDao.boxIdsWithPrefix(prefix))
                boxId = generatedId

                pickingDao.insertBox(
                    ShippingBoxEntity(
                        id = generatedId, pickingOrderId = pickingOrderId, measuringTaskId = null,
                        status = "open", grossWeight = null, netWeight = null,
                        destinationCountry = null, boxSize = null, createdAt = now,
                    )
                )
                pickingDao.insertLog(
                    TransitionLogEntity(
                        id = UUID.randomUUID().toString(),
                        entityType = "shipping_box", entityId = generatedId,
                        fromState = null, toState = "open", actorId = actorId,
                        metadata = JSONObject().apply { put("pickingOrderId", pickingOrderId) }.toString(),
                        createdAt = now,
                    )
                )
            }
            boxId!!
        }

    /** Port of web addPackageToBox. */
    suspend fun addPackageToBox(
        packageId: String,
        shippingBoxId: String,
        actorId: String,
        skipAutoFinish: Boolean = false,
    ) = withContext(Dispatchers.IO) {
        if (actorId.isEmpty()) throw LocalizedException("actor_required")
        db.runInTransaction { addPackageToBoxInternal(packageId, shippingBoxId, actorId, skipAutoFinish) }
        Unit
    }

    private fun addPackageToBoxInternal(
        packageId: String,
        shippingBoxId: String,
        actorId: String,
        skipAutoFinish: Boolean,
    ) {
        val pkg = pickingDao.packageById(packageId) ?: throw LocalizedException("package_not_found")
        if (pkg.shippingBoxId != null) throw LocalizedException("package_already_in_box")

        val box = pickingDao.boxById(shippingBoxId) ?: throw LocalizedException("box_not_found")
        if (box.status != "open") throw LocalizedException("box_is_not_open")
        val boxOrderId = box.pickingOrderId ?: throw LocalizedException("shipping_box_not_associated")
        val order = pickingDao.pickingOrderById(boxOrderId)
        if (order?.status == "issue") throw LocalizedException("picking_order_has_open_issue")
        if (order?.status == "finished") throw LocalizedException("picking_order_already_finished")
        if (boxOrderId != pkg.pickingOrderId) {
            throw LocalizedException("package_does_not_belong_to_picking_order")
        }

        pickingDao.assignPackageToBox(packageId, shippingBoxId)
        refreshPickingItemPickedQty(pkg.pickingItemId)

        pickingDao.insertLog(
            TransitionLogEntity(
                id = UUID.randomUUID().toString(),
                entityType = "picking_item", entityId = pkg.pickingItemId,
                fromState = "scanned", toState = "boxed", actorId = actorId,
                metadata = JSONObject().apply {
                    put("packageId", packageId); put("shippingBoxId", shippingBoxId); put("qty", pkg.qty)
                }.toString(),
                createdAt = System.currentTimeMillis(),
            )
        )

        if (!skipAutoFinish) maybeAutoFinishPickingOrderInternal(pkg.pickingOrderId, actorId)
    }

    /** Port of web addAllUnboxedPackagesToBox. Returns the number of packages boxed. */
    suspend fun addAllUnboxedPackagesToBox(shippingBoxId: String, actorId: String): Int =
        withContext(Dispatchers.IO) {
            if (actorId.isEmpty()) throw LocalizedException("actor_required")
            var count = 0
            db.runInTransaction {
                val box = pickingDao.boxById(shippingBoxId) ?: throw LocalizedException("box_not_found")
                if (box.status != "open") throw LocalizedException("box_is_not_open")
                val boxOrderId = box.pickingOrderId ?: throw LocalizedException("shipping_box_not_associated")

                val packages = pickingDao.unboxedPackagesOfOrder(boxOrderId)
                for (pkg in packages) {
                    addPackageToBoxInternal(pkg.id, shippingBoxId, actorId, skipAutoFinish = true)
                }
                maybeAutoFinishPickingOrderInternal(boxOrderId, actorId)
                count = packages.size
            }
            count
        }

    /** Port of web removePackageFromBox. */
    suspend fun removePackageFromBox(packageId: String, actorId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val pkg = pickingDao.packageById(packageId) ?: throw LocalizedException("package_not_found")
            val shippingBoxId = pkg.shippingBoxId ?: throw LocalizedException("package_not_in_box")

            val box = pickingDao.boxById(shippingBoxId)
            if (box == null || box.status != "open") throw LocalizedException("box_is_not_open")
            if (box.pickingOrderId != null) {
                val order = pickingDao.pickingOrderById(box.pickingOrderId)
                if (order?.status == "issue") throw LocalizedException("picking_order_has_open_issue")
            }

            pickingDao.unassignPackageFromBox(packageId)
            refreshPickingItemPickedQty(pkg.pickingItemId)

            pickingDao.insertLog(
                TransitionLogEntity(
                    id = UUID.randomUUID().toString(),
                    entityType = "picking_item", entityId = pkg.pickingItemId,
                    fromState = "boxed", toState = "scanned", actorId = actorId,
                    metadata = JSONObject().apply {
                        put("packageId", packageId); put("shippingBoxId", shippingBoxId); put("qty", pkg.qty)
                    }.toString(),
                    createdAt = System.currentTimeMillis(),
                )
            )
        }
        Unit
    }

    /** Port of web maybeAutoFinishPickingOrder (standalone transaction). */
    suspend fun maybeAutoFinishPickingOrder(pickingOrderId: String, actorId: String) =
        withContext(Dispatchers.IO) {
            db.runInTransaction { maybeAutoFinishPickingOrderInternal(pickingOrderId, actorId) }
            Unit
        }

    private fun maybeAutoFinishPickingOrderInternal(pickingOrderId: String, actorId: String) {
        val order = pickingDao.pickingOrderById(pickingOrderId) ?: return
        if (order.status == "finished") return
        val items = pickingDao.itemsOfPickingOrder(pickingOrderId)
        if (items.isEmpty()) return
        if (!items.all { it.pickedQty >= it.qty }) return

        val now = System.currentTimeMillis()
        pickingDao.updatePickingOrderStatus(pickingOrderId, "finished", now)

        val taskId = UUID.randomUUID().toString()
        pickingDao.insertMeasuringTask(
            MeasuringTaskEntity(
                id = taskId, pickingOrderId = pickingOrderId, status = "pending", createdAt = now,
            )
        )
        pickingDao.assignBoxesToMeasuringTask(pickingOrderId, taskId)

        pickingDao.insertLog(
            TransitionLogEntity(
                id = UUID.randomUUID().toString(),
                entityType = "picking_order", entityId = pickingOrderId,
                fromState = "picking", toState = "finished", actorId = actorId,
                metadata = JSONObject().apply { put("auto", true) }.toString(),
                createdAt = now,
            )
        )
    }

    /** Web refreshPickingItemPickedQty: picked_qty = sum of BOXED packages. */
    private fun refreshPickingItemPickedQty(pickingItemId: String) {
        pickingDao.setItemPickedQty(pickingItemId, pickingDao.boxedPackageQty(pickingItemId))
    }

    /**
     * Port of web getLocationBoxIdPrefix: "{prefix}-{locationCode}-{isoWeek:02}{year%100:02}".
     * java.time IsoFields needs API 26 and this app has no coreLibraryDesugaring (minSdk 24),
     * so the ISO week comes from java.util.Calendar configured for ISO-8601 (Monday first,
     * minimal 4 days in first week). Locale.US is pinned so week fields don't depend on the
     * device locale. Like the web, the year is the calendar year, not the week-based year.
     */
    private fun locationBoxIdPrefix(prefix: String, locationCode: String): String {
        val cal = Calendar.getInstance(Locale.US).apply {
            firstDayOfWeek = Calendar.MONDAY
            minimalDaysInFirstWeek = 4
        }
        val week = cal.get(Calendar.WEEK_OF_YEAR).toString().padStart(2, '0')
        val year = (cal.get(Calendar.YEAR) % 100).toString().padStart(2, '0')
        return "$prefix-$locationCode-$week$year"
    }

    /** Port of web generateLocationBoxId: max 6-digit sequence after the prefix, +1, zero-padded. */
    private fun generateLocationBoxId(idPrefix: String, existingIds: List<String>): String {
        val regex = Regex("^${Regex.escape(idPrefix)}([0-9]{6})$")
        var maxSeq = 0
        for (id in existingIds) {
            val match = regex.matchEntire(id) ?: continue
            maxSeq = maxOf(maxSeq, match.groupValues[1].toInt())
        }
        return idPrefix + (maxSeq + 1).toString().padStart(6, '0')
    }
}
