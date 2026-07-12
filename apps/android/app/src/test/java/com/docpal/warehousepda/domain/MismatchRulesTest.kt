package com.docpal.warehousepda.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MismatchRulesTest {

    @Test
    fun `computeReceivedQty per reason`() {
        assertEquals(0, MismatchRules.computeReceivedQty(100, "not_found", null))
        assertEquals(60, MismatchRules.computeReceivedQty(100, "damaged", 40))
        assertEquals(60, MismatchRules.computeReceivedQty(100, "quality_rejection", 40))
        assertEquals(100, MismatchRules.computeReceivedQty(100, "damaged", null)) // bad qty defaults to 0, so received = expected
        assertEquals(70, MismatchRules.computeReceivedQty(100, "qty_mismatch", 70))
        assertEquals(100, MismatchRules.computeReceivedQty(100, "over_shipment", 25)) // capped at expected
        assertEquals(0, MismatchRules.computeReceivedQty(100, "wrong_part", 100))
    }

    @Test
    fun `damaged bad qty larger than expected clamps to zero`() {
        assertEquals(0, MismatchRules.computeReceivedQty(10, "damaged", 99))
    }

    private fun errorKey(expected: Int, reason: String?, qty: Int?, wrongPart: String?): String? =
        runCatching { MismatchRules.validateMismatchInputs(expected, reason, qty, wrongPart) }
            .exceptionOrNull()?.let { (it as LocalizedException).code }

    @Test
    fun `validation order and keys`() {
        assertEquals("mismatch_reason_required", errorKey(100, null, null, null))
        assertEquals("not_found_mismatch_cannot_include_qty", errorKey(100, "not_found", 5, null))
        assertEquals("quantity_must_be_non_negative_integer", errorKey(100, "damaged", -1, null))
        assertEquals("damaged_rejected_quantity_exceeds_expected", errorKey(10, "damaged", 11, null))
        assertEquals("damaged_rejected_quantity_exceeds_expected", errorKey(10, "quality_rejection", 11, null))
        assertEquals("quantity_must_be_greater_than_zero", errorKey(100, "over_shipment", 0, null))
        assertEquals("quantity_must_be_greater_than_zero", errorKey(100, "wrong_part", 0, "X"))
        assertEquals("wrong_part_number_required", errorKey(100, "wrong_part", 5, "  "))
        assertEquals("quantity_mismatch_requires_valid_received_qty", errorKey(100, "qty_mismatch", null, null))
    }

    @Test
    fun `valid inputs pass`() {
        MismatchRules.validateMismatchInputs(100, "not_found", null, null)
        MismatchRules.validateMismatchInputs(100, "damaged", 40, null)
        MismatchRules.validateMismatchInputs(100, "qty_mismatch", 0, null)
        MismatchRules.validateMismatchInputs(100, "over_shipment", 25, null)
        MismatchRules.validateMismatchInputs(100, "wrong_part", 100, "ABC-1")
    }

    @Test
    fun `unknown reason throws unhandled_mismatch_reason`() {
        val e = assertThrows(LocalizedException::class.java) {
            MismatchRules.computeReceivedQty(100, "bogus", null)
        }
        assertEquals("unhandled_mismatch_reason", e.code)
    }
}
