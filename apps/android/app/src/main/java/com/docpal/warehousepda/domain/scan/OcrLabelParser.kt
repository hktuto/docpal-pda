package com.docpal.warehousepda.domain.scan

/**
 * Shared scan types (port of the interfaces in apps/web/utils/parseOcrScan.ts).
 * The parseAndIdentify port lands in this file in the next task.
 *
 * Note: the web's `OcrBarcode.format` is a required `string`, so it is
 * non-nullable here too (the earlier sketch had it nullable).
 */
object OcrLabelParser {
    data class OcrBarcode(val value: String, val format: String)
    data class RawOcrCapture(val text: String, val barcodes: List<OcrBarcode>)
    data class ParsedFields(
        val itemId: String?, val qty: Int?, val coo: String?,
        val dateCode: String?, val lotCode: String?, val cow: String?,
    )
    data class CandidateOptions(
        val itemIds: List<String>, val qtys: List<Int>, val coos: List<String>,
        val dateCodes: List<String>, val lotCodes: List<String>, val cows: List<String>,
    )
    data class OcrParseResult(
        val matched: Boolean, val parsed: ParsedFields,
        val options: CandidateOptions, val raw: RawOcrCapture,
    )
}
