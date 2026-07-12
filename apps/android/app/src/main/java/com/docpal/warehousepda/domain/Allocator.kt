package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.db.AllocationEntity
import com.docpal.warehousepda.data.db.AppDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.util.UUID

/** Port of apps/web/db/allocate.ts. */
class Allocator(private val db: AppDatabase) {

    private val dao get() = db.pickingDao()

    data class DateCodeRule(val op: String, val value: String)

    companion object {
        fun parseDateCodeRule(input: String?): DateCodeRule? {
            if (input == null) return null
            val trimmed = input.trim()
            if (trimmed.isEmpty()) return null
            var op = "eq"
            var rest = trimmed
            for (candidate in listOf(">=", "<=", ">", "<")) {
                if (rest.startsWith(candidate)) {
                    op = candidate
                    rest = rest.removePrefix(candidate)
                    break
                }
            }
            val value = rest.trim()
            if (value.isEmpty()) return null
            return DateCodeRule(op, value)
        }

        fun dateCodeMatches(lotDate: String?, rule: DateCodeRule?): Boolean {
            if (rule == null) return true
            if (lotDate == null) return true // null lot date matches any rule (sorts last)
            return when (rule.op) {
                "eq" -> lotDate == rule.value
                ">=" -> lotDate >= rule.value
                "<=" -> lotDate <= rule.value
                ">" -> lotDate > rule.value
                "<" -> lotDate < rule.value
                else -> false
            }
        }
    }

    suspend fun allocatePendingPickingOrders() = withContext(Dispatchers.IO) {
        for (order in dao.pendingPickingOrders()) {
            allocatePickingOrderInternal(order.id)
        }
    }

    suspend fun allocatePickingOrder(pickingOrderId: String) = withContext(Dispatchers.IO) {
        allocatePickingOrderInternal(pickingOrderId)
    }

    private fun allocatePickingOrderInternal(pickingOrderId: String) {
        for (item in dao.itemsOfPickingOrder(pickingOrderId)) {
            val neededAtStart = item.qty - item.pickedQty - item.allocatedQty
            if (neededAtStart <= 0) continue
            db.runInTransaction {
                var needed = neededAtStart
                val rule = parseDateCodeRule(item.requiredDateCode)

                // Phase A: located lots (shelf / shelf-box), date-code rule, nulls sort last.
                val matching = dao.locatedLotsForPart(item.partId)
                    .filter { dateCodeMatches(it.dateCode, rule) }
                    .sortedWith(compareBy({ it.dateCode == null }, { it.dateCode ?: "" }))
                for (lot in matching) {
                    if (needed <= 0) break
                    val take = minOf(needed, lot.availableQty)
                    dao.insertAllocation(
                        AllocationEntity(
                            id = UUID.randomUUID().toString(),
                            pickingItemId = item.id, inventoryLotId = lot.id,
                            receivingOrderId = null, qty = take, remark = null,
                        )
                    )
                    dao.increaseLotAllocated(lot.id, take)
                    dao.increaseItemAllocated(item.id, take)
                    needed -= take
                }

                // Phase B: receiving-area stock, FIFO by delivery date (nulls last).
                if (needed > 0) {
                    for (row in dao.receivingAvailabilityForPart(item.partId)) {
                        if (needed <= 0) break
                        val available = row.physicalQty - row.allocatedQty - row.unboxedQty
                        if (available <= 0) continue
                        val take = minOf(needed, available)
                        val boxIds = dao.boxIdsForOrderPart(row.receivingOrderId, item.partId)
                        val remark = if (boxIds.isEmpty()) null else JSONArray(boxIds).toString()
                        dao.insertAllocation(
                            AllocationEntity(
                                id = UUID.randomUUID().toString(),
                                pickingItemId = item.id, inventoryLotId = null,
                                receivingOrderId = row.receivingOrderId, qty = take, remark = remark,
                            )
                        )
                        dao.increaseItemAllocated(item.id, take)
                        needed -= take
                    }
                }
            }
        }
    }
}
