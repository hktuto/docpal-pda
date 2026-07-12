package com.docpal.warehousepda.domain

/**
 * Pure port of apps/web/db/mismatch.ts computeReceivedQty + validateMismatchInputs.
 * Reasons are stored as strings (matching the seed/schema): not_found, damaged,
 * qty_mismatch, wrong_part, over_shipment, quality_rejection.
 */
object MismatchRules {

    const val NOT_FOUND = "not_found"
    const val DAMAGED = "damaged"
    const val QTY_MISMATCH = "qty_mismatch"
    const val WRONG_PART = "wrong_part"
    const val OVER_SHIPMENT = "over_shipment"
    const val QUALITY_REJECTION = "quality_rejection"

    val ALL_REASONS = listOf(NOT_FOUND, DAMAGED, QTY_MISMATCH, WRONG_PART, OVER_SHIPMENT, QUALITY_REJECTION)

    fun computeReceivedQty(expectedQty: Int, reason: String, mismatchQty: Int?): Int = when (reason) {
        NOT_FOUND -> 0
        DAMAGED, QUALITY_REJECTION -> maxOf(0, expectedQty - (mismatchQty ?: 0))
        QTY_MISMATCH -> mismatchQty ?: 0
        OVER_SHIPMENT -> expectedQty
        WRONG_PART -> 0
        else -> throw LocalizedException("unhandled_mismatch_reason", mapOf("reason" to reason))
    }

    /** Throws LocalizedException with the web's i18n keys, in the web's check order. */
    fun validateMismatchInputs(
        expectedQty: Int,
        reason: String?,
        mismatchQty: Int?,
        wrongPartNo: String?,
    ) {
        if (reason == null) throw LocalizedException("mismatch_reason_required")
        if (reason == NOT_FOUND && mismatchQty != null) {
            throw LocalizedException("not_found_mismatch_cannot_include_qty")
        }
        val qty = mismatchQty ?: 0
        if (qty < 0) throw LocalizedException("quantity_must_be_non_negative_integer")
        if ((reason == DAMAGED || reason == QUALITY_REJECTION) && qty > expectedQty) {
            throw LocalizedException("damaged_rejected_quantity_exceeds_expected")
        }
        if ((reason == OVER_SHIPMENT || reason == WRONG_PART) && qty <= 0) {
            throw LocalizedException("quantity_must_be_greater_than_zero")
        }
        if (reason == WRONG_PART && wrongPartNo.isNullOrBlank()) {
            throw LocalizedException("wrong_part_number_required")
        }
        if (reason == QTY_MISMATCH && mismatchQty == null) {
            throw LocalizedException("quantity_mismatch_requires_valid_received_qty")
        }
        if (computeReceivedQty(expectedQty, reason, mismatchQty) < 0) {
            throw LocalizedException("computed_received_quantity_cannot_be_negative")
        }
    }
}
