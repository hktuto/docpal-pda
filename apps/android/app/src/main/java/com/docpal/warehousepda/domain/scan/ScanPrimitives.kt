package com.docpal.warehousepda.domain.scan

import com.docpal.warehousepda.domain.LocalizedException

/** Port of apps/web/composables/useMockOcr.ts. */
object ScanPrimitives {

    data class OcrInput(
        val partNo: String,
        val dateCode: String,
        val lotCode: String,
        val coo: String,
        val cow: String,
        val qty: String,
    )

    data class OcrParsedFields(
        val partNo: String,
        val dateCode: String?,
        val lotCode: String?,
        val coo: String?,
        val cow: String?,
        val qty: Int,
    )

    /** trim, uppercase, collapse whitespace; keeps dashes/letters (part numbers). */
    fun normalize(value: String): String = value.trim().uppercase().replace(Regex("\\s+"), " ")

    /** normalize + OCR digit substitutions; only for date/lot codes, never part numbers. */
    fun normalizeCode(value: String): String = normalize(value)
        .replace('O', '0')
        .replace('I', '1')
        .replace('L', '1')
        .replace('Z', '2')
        .replace('S', '5')

    /** Remove ALL whitespace (QR matching path). */
    fun collapseSpaces(value: String): String = value.replace(Regex("\\s+"), "")

    fun parseManual(input: OcrInput): OcrParsedFields {
        val qty = input.qty.trim().toIntOrNull()
        if (qty == null || qty <= 0) throw LocalizedException("qty_must_be_positive_integer")
        return OcrParsedFields(
            partNo = normalize(input.partNo),
            dateCode = if (input.dateCode.isEmpty()) null else normalizeCode(input.dateCode),
            lotCode = if (input.lotCode.isEmpty()) null else normalizeCode(input.lotCode),
            coo = if (input.coo.isEmpty()) null else normalize(input.coo),
            cow = if (input.cow.isEmpty()) null else normalize(input.cow),
            qty = qty,
        )
    }
}
