package com.docpal.warehousepda.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class AllocationDistributorTest {

    private fun item(id: String, partId: String, orderId: String, gross: Int, sortKey: Int) =
        AllocationDistributor.InvoiceItemRow(
            id = id, partId = partId, receivingOrderId = orderId, grossQty = gross,
            deliveryDate = sortKey.toLong(), invoiceNo = "INV", dateCode = sortKey.toString(),
        )

    @Test
    fun `allocation fills items in FIFO order`() {
        val items = listOf(
            item("a", "p1", "o1", gross = 100, sortKey = 1),
            item("b", "p1", "o1", gross = 100, sortKey = 2),
            item("c", "p1", "o1", gross = 100, sortKey = 3),
        )
        val totals = mapOf(("o1" to "p1") to 150)
        val result = AllocationDistributor.distribute(items, totals, emptyMap())
        assertEquals(100, result["a"]!!.allocatedQty)
        assertEquals(50, result["b"]!!.allocatedQty)
        assertEquals(0, result["c"]!!.allocatedQty)
    }

    @Test
    fun `allocation larger than stock clamps at gross per item`() {
        val items = listOf(
            item("a", "p1", "o1", gross = 60, sortKey = 1),
            item("b", "p1", "o1", gross = 40, sortKey = 2),
        )
        val result = AllocationDistributor.distribute(items, mapOf(("o1" to "p1") to 999), emptyMap())
        assertEquals(60, result["a"]!!.allocatedQty)
        assertEquals(40, result["b"]!!.allocatedQty)
    }

    @Test
    fun `parts and orders are independent partitions`() {
        val items = listOf(
            item("a", "p1", "o1", gross = 10, sortKey = 1),
            item("b", "p2", "o1", gross = 10, sortKey = 2),
            item("c", "p1", "o2", gross = 10, sortKey = 1),
        )
        val totals = mapOf(("o1" to "p1") to 5, ("o1" to "p2") to 7, ("o2" to "p1") to 3)
        val result = AllocationDistributor.distribute(items, totals, emptyMap())
        assertEquals(5, result["a"]!!.allocatedQty)
        assertEquals(7, result["b"]!!.allocatedQty)
        assertEquals(3, result["c"]!!.allocatedQty)
    }

    @Test
    fun `unboxed scans reserve per item and available subtracts both`() {
        val items = listOf(
            item("a", "p1", "o1", gross = 100, sortKey = 1),
            item("b", "p1", "o1", gross = 100, sortKey = 2),
        )
        val unboxed = mapOf("b" to 30)
        val result = AllocationDistributor.distribute(items, mapOf(("o1" to "p1") to 50), unboxed)
        assertEquals(50, result["a"]!!.availableQty)   // 100 - 50 alloc
        assertEquals(70, result["b"]!!.availableQty)   // 100 - 0 alloc - 30 unboxed
    }

    @Test
    fun `excluded picking item is omitted from allocation totals`() {
        val items = listOf(item("a", "p1", "o1", gross = 100, sortKey = 1))
        // totals map is pre-filtered by the caller; excluding means the key is absent.
        val result = AllocationDistributor.distribute(items, emptyMap(), emptyMap())
        assertEquals(100, result["a"]!!.availableQty)
    }

    @Test
    fun `null delivery date and null date code sort last`() {
        val nullDate = AllocationDistributor.InvoiceItemRow(
            id = "n", partId = "p1", receivingOrderId = "o1", grossQty = 10,
            deliveryDate = null, invoiceNo = "INV", dateCode = null,
        )
        val early = item("e", "p1", "o1", gross = 10, sortKey = 5)
        val result = AllocationDistributor.distribute(
            listOf(nullDate, early), mapOf(("o1" to "p1") to 10), emptyMap()
        )
        assertEquals(10, result["e"]!!.allocatedQty)
        assertEquals(0, result["n"]!!.allocatedQty)
    }
}
