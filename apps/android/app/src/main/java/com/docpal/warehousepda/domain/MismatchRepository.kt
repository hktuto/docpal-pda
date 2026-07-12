package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.ReceivingRepository
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.data.db.ReceivingItemMismatchEntity
import com.docpal.warehousepda.data.db.TransitionLogEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

/** Port of apps/web/db/mismatch.ts mutations. All writes run in a Room transaction. */
class MismatchRepository(
    private val db: AppDatabase,
    private val receivingRepository: ReceivingRepository,
) {

    private val dao get() = db.receivingDao()

    suspend fun reportMismatch(
        itemId: String, actorId: String, reason: String,
        mismatchQty: Int?, wrongPartNo: String?, note: String,
    ) = withContext(Dispatchers.IO) {
        val trimmedWrongPart = wrongPartNo?.trim()?.ifEmpty { null }
        val trimmedNote = note.trim().ifEmpty { null }
        db.runInTransaction {
            val item = dao.itemById(itemId) ?: throw LocalizedException("receiving_invoice_item_not_found")
            val existing = dao.activeMismatchForItem(itemId)
            if (existing?.status == "confirmed") throw LocalizedException("confirmed_mismatch_already_exists")
            if (existing != null) throw LocalizedException("pending_mismatch_already_exists")
            MismatchRules.validateMismatchInputs(item.qty, reason, mismatchQty, trimmedWrongPart)
            val effective = MismatchRules.computeReceivedQty(item.qty, reason, mismatchQty)
            assertCanApplyMismatchQty(itemId, effective)
            val now = System.currentTimeMillis()
            dao.insertMismatch(
                ReceivingItemMismatchEntity(
                    id = UUID.randomUUID().toString(),
                    receivingInvoiceItemId = itemId,
                    reason = reason,
                    mismatchQty = if (reason != MismatchRules.NOT_FOUND) mismatchQty else null,
                    wrongPartNo = if (reason == MismatchRules.WRONG_PART) trimmedWrongPart else null,
                    note = trimmedNote,
                    status = "pending",
                    effectiveReceivedQty = effective,
                    previousReceivedQty = item.receivedQty,
                    reportedBy = actorId,
                    reportedAt = now,
                    confirmedBy = null, confirmedAt = null,
                    cancelledBy = null, cancelledAt = null,
                )
            )
            dao.updateItemReceivedQty(itemId, effective)
            markOrderTransitions(item.receivingInvoiceId, actorId)
            logTransition(itemId, null, "pending", actorId, now, JSONObject().apply {
                put("reason", reason)
                put("mismatchQty", mismatchQty ?: JSONObject.NULL)
                put("wrongPartNo", trimmedWrongPart ?: JSONObject.NULL)
                put("effectiveReceivedQty", effective)
                put("note", trimmedNote ?: JSONObject.NULL)
            }.toString())
        }
    }

    suspend fun editMismatch(
        mismatchId: String, actorId: String, reason: String,
        mismatchQty: Int?, wrongPartNo: String?, note: String,
    ) = withContext(Dispatchers.IO) {
        val trimmedWrongPart = wrongPartNo?.trim()?.ifEmpty { null }
        val trimmedNote = note.trim().ifEmpty { null }
        db.runInTransaction {
            val mismatch = dao.mismatchById(mismatchId)
                ?: throw LocalizedException("receiving_item_mismatch_not_found")
            if (mismatch.status != "pending") throw LocalizedException("only_pending_mismatch_can_be_edited")
            if (mismatch.reportedBy != actorId) throw LocalizedException("only_reporter_can_edit_mismatch")
            val item = dao.itemById(mismatch.receivingInvoiceItemId)
                ?: throw LocalizedException("receiving_invoice_item_not_found")
            MismatchRules.validateMismatchInputs(item.qty, reason, mismatchQty, trimmedWrongPart)
            val effective = MismatchRules.computeReceivedQty(item.qty, reason, mismatchQty)
            assertCanApplyMismatchQty(item.id, effective)
            val now = System.currentTimeMillis()
            dao.updateMismatchFields(
                mismatchId, reason,
                if (reason != MismatchRules.NOT_FOUND) mismatchQty else null,
                if (reason == MismatchRules.WRONG_PART) trimmedWrongPart else null,
                trimmedNote, effective,
            )
            dao.updateItemReceivedQty(item.id, effective)
            markOrderTransitions(item.receivingInvoiceId, actorId)
            logTransition(item.id, "pending", "pending", actorId, now, JSONObject().apply {
                put("reason", reason)
                put("mismatchQty", mismatchQty ?: JSONObject.NULL)
                put("wrongPartNo", trimmedWrongPart ?: JSONObject.NULL)
                put("effectiveReceivedQty", effective)
                put("note", trimmedNote ?: JSONObject.NULL)
            }.toString())
        }
    }

    suspend fun confirmMismatch(mismatchId: String, actorId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val mismatch = dao.mismatchById(mismatchId)
                ?: throw LocalizedException("receiving_item_mismatch_not_found")
            if (mismatch.status != "pending") throw LocalizedException("only_pending_mismatch_can_be_confirmed")
            if (mismatch.reportedBy == actorId) throw LocalizedException("reporter_cannot_confirm_own_mismatch")
            val now = System.currentTimeMillis()
            dao.markMismatchConfirmed(mismatchId, "confirmed", actorId, now)
            logTransition(
                mismatch.receivingInvoiceItemId, "pending", "confirmed", actorId, now,
                JSONObject().put("mismatchId", mismatchId).toString(),
            )
        }
    }

    suspend fun cancelMismatch(mismatchId: String, actorId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val mismatch = dao.mismatchById(mismatchId)
                ?: throw LocalizedException("receiving_item_mismatch_not_found")
            if (mismatch.status != "pending") throw LocalizedException("only_pending_mismatch_can_be_cancelled")
            if (mismatch.reportedBy == actorId) throw LocalizedException("reporter_cannot_cancel_own_mismatch")
            assertCanApplyMismatchQty(mismatch.receivingInvoiceItemId, mismatch.previousReceivedQty)
            val item = dao.itemById(mismatch.receivingInvoiceItemId)
                ?: throw LocalizedException("receiving_invoice_item_not_found")
            val now = System.currentTimeMillis()
            dao.markMismatchCancelled(mismatchId, "cancelled", actorId, now)
            dao.updateItemReceivedQty(item.id, mismatch.previousReceivedQty)
            markOrderTransitions(item.receivingInvoiceId, actorId)
            logTransition(item.id, "pending", "cancelled", actorId, now, JSONObject().apply {
                put("mismatchId", mismatchId)
                put("revertedToQty", mismatch.previousReceivedQty)
            }.toString())
        }
    }

    /** effective < picked + putAway + allocated → reject (web assertCanApplyMismatchQty). */
    private fun assertCanApplyMismatchQty(itemId: String, effectiveReceivedQty: Int) {
        val item = dao.itemById(itemId) ?: throw LocalizedException("receiving_invoice_item_not_found")
        val invoiceOrderId = dao.orderIdOfInvoice(item.receivingInvoiceId) ?: return
        val allocated = receivingRepository.availableQtyByItem(invoiceOrderId)[itemId]?.let { available ->
            item.receivedQty - item.pickedQty - item.putAwayQty - available
        } ?: 0
        // Derives allocated+unboxed from the distributor output:
        // available = received - picked - putAway - (allocated + unboxed).
        // Includes unboxed scans; equivalent to web while put_away_scans is empty
        // (no put-away UI until Phase 3).
        val consumed = item.pickedQty + item.putAwayQty + allocated
        if (effectiveReceivedQty < consumed) throw LocalizedException("mismatch_qty_below_consumed_stock")
    }

    private fun markOrderTransitions(invoiceId: String, actorId: String) {
        val orderId = dao.orderIdOfInvoice(invoiceId) ?: return
        receivingRepository.tryMarkClear(orderId, actorId)
        receivingRepository.tryMarkInHand(orderId, actorId)
    }

    private fun logTransition(
        itemId: String, from: String?, to: String, actorId: String, now: Long, metadata: String?,
    ) {
        dao.insertTransitionLog(
            TransitionLogEntity(
                id = UUID.randomUUID().toString(),
                entityType = "receiving_item_mismatch",
                entityId = itemId, // web logs against the invoice item id, not the mismatch id
                fromState = from, toState = to,
                actorId = actorId, metadata = metadata, createdAt = now,
            )
        )
    }
}
