package com.docpal.warehousepda.domain

/**
 * Kotlin port of the web `allocationsCte` (apps/web/db/helpers.ts).
 *
 * Order-level allocations (receiving_order_id + part via the picking item) are
 * distributed across that part's invoice items in FIFO order:
 *   delivery_date ASC NULLS LAST, invoice_no ASC, date_code ASC NULLS LAST.
 * Each item absorbs max(0, min(gross, total - consumedByEarlierItems)).
 * Unboxed put-away scans reserve per item directly (no distribution).
 *
 * The Postgres original uses window functions; this port exists because
 * minSdk 24 ships SQLite 3.9 without window functions.
 */
object AllocationDistributor {

    data class InvoiceItemRow(
        val id: String,
        val partId: String,
        val receivingOrderId: String,
        /** received_qty - picked_qty - put_away_qty */
        val grossQty: Int,
        /** Epoch millis; null sorts last (Postgres NULLS LAST). */
        val deliveryDate: Long?,
        val invoiceNo: String,
        /** Compared lexicographically; null sorts last. */
        val dateCode: String?,
    )

    data class ItemAvailability(
        val allocatedQty: Int,
        val unboxedScannedQty: Int,
        val availableQty: Int,
    )

    /**
     * @param items        all invoice item rows to reserve against (any order; sorted internally)
     * @param allocationTotals  (receivingOrderId, partId) -> total allocated qty (pre-filtered for exclusions)
     * @param unboxedByItem     receiving_invoice_item_id -> unboxed put-away scan qty
     * @return receiving_invoice_item_id -> availability breakdown
     *
     * Ties on all sort keys resolve by caller input order (stable sort).
     */
    fun distribute(
        items: List<InvoiceItemRow>,
        allocationTotals: Map<Pair<String, String>, Int>,
        unboxedByItem: Map<String, Int>,
    ): Map<String, ItemAvailability> {
        val result = HashMap<String, ItemAvailability>(items.size)
        val byPartition = items.groupBy { it.receivingOrderId to it.partId }
        for ((key, partitionItems) in byPartition) {
            val total = allocationTotals[key] ?: 0
            val sorted = partitionItems.sortedWith(
                compareBy(
                    { it.deliveryDate == null },   // NULLS LAST
                    { it.deliveryDate ?: 0L },
                    { it.invoiceNo },
                    { it.dateCode == null },        // NULLS LAST
                    { it.dateCode ?: "" },
                )
            )
            var consumed = 0
            for (row in sorted) {
                val allocated = maxOf(0, minOf(row.grossQty, total - consumed))
                consumed += row.grossQty
                val unboxed = unboxedByItem[row.id] ?: 0
                result[row.id] = ItemAvailability(
                    allocatedQty = allocated,
                    unboxedScannedQty = unboxed,
                    availableQty = row.grossQty - allocated - unboxed,
                )
            }
        }
        return result
    }
}
