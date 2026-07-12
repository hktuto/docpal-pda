package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.ReceivingAvailability
import com.docpal.warehousepda.data.ReceivingRepository
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.data.db.InventoryLotEntity
import com.docpal.warehousepda.data.db.InventoryLotSourceEntity
import com.docpal.warehousepda.data.db.PutAwayScanEntity
import com.docpal.warehousepda.data.db.ShelfBoxEntity
import com.docpal.warehousepda.data.db.TransitionLogEntity
import com.docpal.warehousepda.domain.model.PutAwayBoxContent
import com.docpal.warehousepda.domain.model.PutAwayBoxDetail
import com.docpal.warehousepda.domain.model.PutAwayCandidate
import com.docpal.warehousepda.domain.model.PutAwayDetail
import com.docpal.warehousepda.domain.model.PutAwayLotDetail
import com.docpal.warehousepda.domain.model.PutAwayOrderHeader
import com.docpal.warehousepda.domain.model.PutAwayScanDetail
import com.docpal.warehousepda.domain.model.ShelfOption
import com.docpal.warehousepda.ui.putaway.PutAwayListSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

/**
 * Put-away read model + scan/box mutations. Port of web getPutAwayCandidates
 * (apps/web/db/putAway.ts): in-hand receiving orders kept when SUM(available_qty) > 0 OR any
 * unboxed put-away scan exists (the web HAVING clause). getPutAwayDetail assembles the detail
 * page (header, lots, scans, boxes, shelves) from the flat DAO rows. Per-item availability
 * reuses [ReceivingAvailability] — the same AllocationDistributor math as the receiving
 * screens; do not duplicate it. The mutations port web recordPutAwayScan / createShelfBox /
 * removeScannedPiece / assignScanToBox / addAllUnboxedToBox / removeScanFromBox /
 * closeShelfBox / cancelShelfBox keeping the web's error codes (nextShelfBoxId follows the
 * API variant, apps/api/src/db/putAway.ts); assign/remove/close end with the shared
 * [ReceivingRepository.tryMarkClear] auto-clear check (Room runInTransaction passes through
 * when already in a transaction, same as PickingRepository's usage).
 * Threading matches the other repositories: suspend entry points wrap plain blocking Room
 * calls in withContext(Dispatchers.IO).
 */
class PutAwayRepository(
    private val db: AppDatabase,
    private val receivingRepository: ReceivingRepository,
) : PutAwayListSource {

    private val putAwayDao get() = db.putAwayDao()
    private val receivingDao get() = db.receivingDao()

    override suspend fun listCandidates(): List<PutAwayCandidate> = withContext(Dispatchers.IO) {
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

    /**
     * Port of web recordPutAwayScan: validates the item exists, the qty is positive, and the
     * qty does not exceed the item's remaining availability, then inserts an unboxed scan
     * carrying the item's part_id. No status changes, no clear check. Returns the new scan id.
     */
    suspend fun recordPutAwayScan(
        receivingInvoiceItemId: String,
        qty: Int,
        dateCode: String?,
        lotCode: String?,
        coo: String?,
        cow: String?,
    ): String = withContext(Dispatchers.IO) {
        var scanId: String? = null
        db.runInTransaction {
            val item = putAwayDao.scanItemRow(receivingInvoiceItemId)
                ?: throw LocalizedException("invoice_item_not_found")
            if (qty <= 0) throw LocalizedException("qty_must_be_positive_integer")
            // Remaining = per-item available from the shared availability math, clamped >= 0
            // like the read model: over-allocated/over-scanned items go negative in the
            // distributor, and a positive qty exceeds 0 either way.
            val order = receivingDao.orderById(item.orderId)
            val availability = ReceivingAvailability.byItem(
                receivingDao, item.orderId, receivingDao.detailItemRows(item.orderId), order?.deliveryDate,
            )
            val remaining = maxOf(0, availability[receivingInvoiceItemId]?.availableQty ?: 0)
            if (qty > remaining) throw LocalizedException("scanned_qty_exceeds_total")
            val id = UUID.randomUUID().toString()
            putAwayDao.insertScan(
                PutAwayScanEntity(
                    id = id,
                    receivingInvoiceItemId = receivingInvoiceItemId,
                    partId = item.partId,
                    qty = qty,
                    dateCode = dateCode,
                    lotCode = lotCode,
                    coo = coo,
                    cow = cow,
                    shelfBoxId = null,
                    verified = false,
                    verifiedAt = null,
                    createdAt = System.currentTimeMillis(),
                )
            )
            scanId = id
        }
        scanId!!
    }

    /**
     * Port of web createShelfBox: validates order + shelf, assigns the next SBOX id, inserts
     * the open box and its transition log (web pglite metadata {receivingOrderId, shelfCode}).
     * Returns the generated box id.
     */
    suspend fun createShelfBox(orderId: String, shelfCode: String, actorId: String): String =
        withContext(Dispatchers.IO) {
            var boxId: String? = null
            db.runInTransaction {
                receivingDao.orderById(orderId) ?: throw LocalizedException("receiving_order_not_found")
                putAwayDao.shelfCodeOf(shelfCode) ?: throw LocalizedException("shelf_not_found")
                val id = nextShelfBoxId()
                val now = System.currentTimeMillis()
                putAwayDao.insertBox(
                    ShelfBoxEntity(
                        id = id, receivingOrderId = orderId, shelfCode = shelfCode,
                        status = "open", createdAt = now,
                    )
                )
                putAwayDao.insertLog(
                    TransitionLogEntity(
                        id = UUID.randomUUID().toString(),
                        entityType = "shelf_box", entityId = id,
                        fromState = null, toState = "open", actorId = actorId,
                        metadata = JSONObject().apply {
                            put("receivingOrderId", orderId)
                            put("shelfCode", shelfCode)
                        }.toString(),
                        createdAt = now,
                    )
                )
                boxId = id
            }
            boxId!!
        }

    /**
     * API nextShelfBoxId parity (apps/api/src/db/putAway.ts): cancelled boxes are hard-deleted,
     * so the max numeric SBOX suffix comes from both shelf_boxes and transition_logs —
     * cancelled ids are never reissued. SBOX-%04d.
     */
    private fun nextShelfBoxId(): String {
        val boxMax = putAwayDao.maxShelfBoxIdSuffix() ?: 0
        val logMax = putAwayDao.maxShelfBoxLogIdSuffix() ?: 0
        return "SBOX-" + (maxOf(boxMax, logMax) + 1).toString().padStart(4, '0')
    }

    /** Port of web removeScannedPiece: hard delete, unboxed scans only. */
    suspend fun removeScannedPiece(scanId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val scan = putAwayDao.scanById(scanId) ?: throw LocalizedException("put_away_scan_not_found")
            if (scan.shelfBoxId != null) throw LocalizedException("put_away_scan_already_boxed")
            putAwayDao.deleteScan(scanId)
        }
        Unit
    }

    /**
     * Port of web assignScanToBox (apps/api/src/db/putAway.ts:129-181): validates scan/box/item,
     * boxes the scan, materializes the inventory lot + lot source, bumps put_away_qty, then runs
     * the receiving-order clear check. Not ported (deliberate): scheduleCycleCount —
     * verification_tasks don't exist on Android (Phase 4 lists boxes directly), so the scan's
     * verified flag stays 0 until goods-verify.
     */
    suspend fun assignScanToBox(scanId: String, boxId: String, actorId: String) =
        withContext(Dispatchers.IO) {
            db.runInTransaction { assignScanToBoxInternal(scanId, boxId, actorId) }
            Unit
        }

    /** Tx-internal assign — also driven by [addAllUnboxedToBox] inside its single transaction. */
    internal fun assignScanToBoxInternal(scanId: String, boxId: String, actorId: String) {
        val scan = putAwayDao.scanById(scanId) ?: throw LocalizedException("put_away_scan_not_found")
        if (scan.shelfBoxId != null) throw LocalizedException("put_away_scan_already_boxed")
        val box = putAwayDao.boxById(boxId) ?: throw LocalizedException("shelf_box_not_found")
        if (box.status != "open") throw LocalizedException("shelf_box_is_not_open")
        val itemId = scan.receivingInvoiceItemId ?: throw LocalizedException("invoice_item_not_found")
        val item = putAwayDao.scanItemRow(itemId) ?: throw LocalizedException("invoice_item_not_found")
        if (box.receivingOrderId != item.orderId) {
            throw LocalizedException("item_does_not_belong_to_receiving_order")
        }

        putAwayDao.assignScanToBox(scanId, boxId)
        val lotId = upsertMaterializedLot(scan, item.partId, box)
        upsertLotSource(lotId, itemId, scan.qty)
        putAwayDao.increaseItemPutAwayQty(itemId, scan.qty)
        receivingRepository.tryMarkClear(item.orderId, actorId)
    }

    /**
     * Lot materialization upsert (web assignScanToBox): the merge key is exactly the
     * inventory_lots unique-index columns (part_id, date_code, coo, cow, shelf_code, box_id) —
     * lot_code is NOT part of the key, so scans with differing lot codes merge into the one
     * physical lot per box slot. Match → total_qty/available_qty += scan qty; else insert
     * (allocated_qty = 0, lot_code from the scan).
     */
    private fun upsertMaterializedLot(scan: PutAwayScanEntity, partId: String, box: ShelfBoxEntity): String {
        val existing =
            putAwayDao.lotByMergeKey(partId, scan.dateCode, scan.coo, scan.cow, box.shelfCode, box.id)
        if (existing != null) {
            putAwayDao.increaseLotAvailableQtys(existing.id, scan.qty)
            return existing.id
        }
        val lotId = UUID.randomUUID().toString()
        putAwayDao.insertLot(
            InventoryLotEntity(
                id = lotId, partId = partId,
                dateCode = scan.dateCode, lotCode = scan.lotCode, coo = scan.coo, cow = scan.cow,
                shelfCode = box.shelfCode, boxId = box.id,
                totalQty = scan.qty, allocatedQty = 0, availableQty = scan.qty,
            )
        )
        return lotId
    }

    /** Lot source upsert on (inventory_lot_id, receiving_invoice_item_id): qty += or insert. */
    private fun upsertLotSource(lotId: String, itemId: String, qty: Int) {
        val existing = putAwayDao.lotSourceByLotAndItem(lotId, itemId)
        if (existing != null) {
            putAwayDao.increaseLotSourceQty(existing.id, qty)
        } else {
            putAwayDao.insertLotSource(
                InventoryLotSourceEntity(
                    id = UUID.randomUUID().toString(),
                    inventoryLotId = lotId, receivingInvoiceItemId = itemId, qty = qty,
                )
            )
        }
    }

    /**
     * Port of web addAllUnboxedToBox (apps/api/src/db/putAway.ts:183-195): assigns every unboxed
     * scan of the box's receiving order, oldest first, in one transaction — if any assign throws,
     * everything rolls back. Returns the assigned count.
     */
    suspend fun addAllUnboxedToBox(boxId: String, actorId: String): Int = withContext(Dispatchers.IO) {
        var count = 0
        db.runInTransaction {
            val box = putAwayDao.boxById(boxId) ?: throw LocalizedException("shelf_box_not_found")
            if (box.status != "open") throw LocalizedException("shelf_box_is_not_open")
            val scanIds = box.receivingOrderId?.let { putAwayDao.unboxedScanIdsOfOrder(it) } ?: emptyList()
            for (scanId in scanIds) assignScanToBoxInternal(scanId, boxId, actorId)
            count = scanIds.size
        }
        count
    }

    /**
     * Port of web removeScanFromBox (apps/api/src/db/putAway.ts:197-240): unboxes the scan and
     * reverses the lot materialization + put_away_qty. API allocation guard: a materialized lot
     * with any allocation rows (even fully picked) no longer maps to this scan —
     * lot_has_pick_allocations (the web API's unmapped 409, mapped properly here). The trailing
     * clear check is web parity; practically a no-op since removal only restores availability
     * (web never flips clear → in_hand, and neither do we).
     */
    suspend fun removeScanFromBox(scanId: String, actorId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val scan = putAwayDao.scanById(scanId) ?: throw LocalizedException("put_away_scan_not_found")
            val boxId = scan.shelfBoxId ?: throw LocalizedException("put_away_scan_not_boxed")
            val box = putAwayDao.boxById(boxId) ?: throw LocalizedException("shelf_box_not_found")
            if (box.status != "open") throw LocalizedException("shelf_box_is_not_open")
            val itemId = scan.receivingInvoiceItemId ?: throw LocalizedException("invoice_item_not_found")
            val item = putAwayDao.scanItemRow(itemId) ?: throw LocalizedException("invoice_item_not_found")

            putAwayDao.unassignScanFromBox(scanId)

            // Reverse the lot materialization: the lot via the same six-column merge key
            // (lot_code excluded), the source via (inventory_lot_id, receiving_invoice_item_id).
            // Missing rows mean data inconsistency — web pglite throws inventory_lot_not_found.
            val lot = putAwayDao.lotByMergeKey(item.partId, scan.dateCode, scan.coo, scan.cow, box.shelfCode, boxId)
                ?: throw LocalizedException("inventory_lot_not_found")
            val source = putAwayDao.lotSourceByLotAndItem(lot.id, itemId)
                ?: throw LocalizedException("inventory_lot_not_found")
            if (putAwayDao.allocationCountForLot(lot.id) > 0) {
                throw LocalizedException("lot_has_pick_allocations")
            }
            if (source.qty - scan.qty <= 0) putAwayDao.deleteLotSource(source.id)
            else putAwayDao.decreaseLotSourceQty(source.id, scan.qty)
            if (lot.totalQty - scan.qty <= 0) putAwayDao.deleteLot(lot.id)
            else putAwayDao.decreaseLotAvailableQtys(lot.id, scan.qty)

            putAwayDao.decreaseItemPutAwayQty(itemId, scan.qty)
            receivingRepository.tryMarkClear(item.orderId, actorId)
        }
        Unit
    }

    /** Port of web closeShelfBox (:256-263): open box with at least one scan → closed + log + clear check. */
    suspend fun closeShelfBox(boxId: String, actorId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val box = putAwayDao.boxById(boxId) ?: throw LocalizedException("shelf_box_not_found")
            if (box.status != "open") throw LocalizedException("shelf_box_is_not_open")
            if (putAwayDao.scanCountInBox(boxId) == 0) throw LocalizedException("cannot_close_empty_shelf_box")
            putAwayDao.updateBoxStatus(boxId, "closed")
            insertBoxTransitionLog(boxId, from = "open", to = "closed", actorId = actorId)
            box.receivingOrderId?.let { receivingRepository.tryMarkClear(it, actorId) }
        }
        Unit
    }

    /**
     * Port of web cancelShelfBox (:44-51): open + empty → cancelled transition log, then hard
     * delete the box row. The id survives in transition_logs, so nextShelfBoxId never reissues it.
     */
    suspend fun cancelShelfBox(boxId: String, actorId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val box = putAwayDao.boxById(boxId) ?: throw LocalizedException("shelf_box_not_found")
            if (box.status != "open") throw LocalizedException("shelf_box_is_not_open")
            if (putAwayDao.scanCountInBox(boxId) > 0) throw LocalizedException("shelf_box_is_not_empty")
            insertBoxTransitionLog(boxId, from = "open", to = "cancelled", actorId = actorId)
            putAwayDao.deleteBox(boxId)
        }
        Unit
    }

    /** Shelf-box transition log row (web logTransition; no metadata for close/cancel). */
    private fun insertBoxTransitionLog(boxId: String, from: String?, to: String, actorId: String) {
        putAwayDao.insertLog(
            TransitionLogEntity(
                id = UUID.randomUUID().toString(),
                entityType = "shelf_box", entityId = boxId,
                fromState = from, toState = to, actorId = actorId,
                metadata = null, createdAt = System.currentTimeMillis(),
            )
        )
    }
}
