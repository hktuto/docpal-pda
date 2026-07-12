package com.docpal.warehousepda.domain.scan

import java.util.regex.Pattern

/**
 * Shared scan types + 1:1 port of parseAndIdentify and its helpers from
 * apps/web/utils/parseOcrScan.ts. decodeKoaQty / parseQrCapture live in QrParser.
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

    private val COUNTRY_NAME_TO_CODE = mapOf(
        "CHINA" to "CN",
        "SLOVENIA" to "SI",
        "JAPAN" to "JP",
        "INDIA" to "IN",
        "GERMANY" to "DE",
        "KOREA" to "KR",
        "MALAYSIA" to "MY",
        "INDONESIA" to "ID",
        "TAIWAN" to "TW",
        "THAILAND" to "TH",
        "VIETNAM" to "VN",
        "USA" to "US",
        "AMERICA" to "US",
        "UNITEDSTATES" to "US",
        "SINGAPORE" to "SG",
        "PHILIPPINES" to "PH",
    )

    private val OCR_SUBSTITUTIONS = mapOf(
        '0' to listOf('0', 'O'),
        'O' to listOf('O', '0'),
        '1' to listOf('1', 'I', 'L'),
        'I' to listOf('I', '1', 'L'),
        'L' to listOf('L', '1', 'I'),
        '2' to listOf('2', 'Z'),
        'Z' to listOf('Z', '2'),
        '5' to listOf('5', 'S'),
        'S' to listOf('S', '5'),
        '8' to listOf('8', 'B'),
        'B' to listOf('B', '8'),
    )

    private fun normalizeText(value: String): String = ScanPrimitives.normalize(value)

    private fun collapseSpaces(value: String): String = ScanPrimitives.collapseSpaces(value)

    private fun generateVariants(value: String): List<String> {
        val base = collapseSpaces(value.uppercase())
        val results = LinkedHashSet<String>()

        fun generate(index: Int, current: String) {
            if (index >= base.length) {
                results.add(current)
                return
            }
            val replacements = OCR_SUBSTITUTIONS[base[index]] ?: listOf(base[index])
            for (replacement in replacements) {
                generate(index + 1, current + replacement)
            }
        }

        generate(0, "")
        return results.toList()
    }

    /** Web's extractWithRegex: exec-loop over the normalized text, collect trimmed group 1. */
    private fun extractWithRegex(text: String, pattern: Pattern): List<String> {
        val results = ArrayList<String>()
        val normalized = normalizeText(text)
        val matcher = pattern.matcher(normalized)
        while (matcher.find()) {
            val value = matcher.group(1)?.trim()
            if (!value.isNullOrEmpty()) results.add(value)
        }
        return results
    }

    private val PART_NO_CHARSET = Regex("^[A-Z0-9\\-]+$")

    private fun looksLikePartNumber(value: String): Boolean {
        val collapsed = collapseSpaces(value)
        return PART_NO_CHARSET.matches(collapsed) &&
            collapsed.any { it in 'A'..'Z' } &&
            collapsed.any { it in '0'..'9' } &&
            collapsed.length >= 4
    }

    private val SUPPLIER_PREFIX =
        Pattern.compile("^(KOA\\+|ABLIC\\+|DIOTEC\\+|MMC\\+|DAITO\\+)", Pattern.CASE_INSENSITIVE)

    private fun stripSupplierPrefixes(value: String): String =
        SUPPLIER_PREFIX.matcher(value).replaceFirst("")

    private class BarcodeSegments {
        val partNo = ArrayList<String>()
        val qty = ArrayList<String>()
        val dateCode = ArrayList<String>()
        val lotCode = ArrayList<String>()
        val coo = ArrayList<String>()
        val cow = ArrayList<String>()
    }

    private val SEGMENT_REGEX = Pattern.compile("\\(([A-Z0-9]+)\\)([^\\(]+)")

    private fun parseBarcodeSegments(barcodes: List<OcrBarcode>): BarcodeSegments {
        val segments = BarcodeSegments()

        for (barcode in barcodes) {
            val value = normalizeText(barcode.value)

            // GS1 / ANSI MH10.8.2 style identifiers: (P)VALUE (Q)VALUE etc.
            val matcher = SEGMENT_REGEX.matcher(value)
            var foundSegments = false
            while (matcher.find()) {
                foundSegments = true
                val key = matcher.group(1)!!.trim().uppercase()
                val segmentValue = matcher.group(2)!!.trim()

                when (key) {
                    "P", "1P" -> segments.partNo.add(segmentValue)
                    "Q" -> segments.qty.add(segmentValue)
                    "D" -> segments.dateCode.add(segmentValue)
                    "L", "T", "1T" -> segments.lotCode.add(segmentValue)
                    "COO" -> segments.coo.add(segmentValue)
                    "COW" -> segments.cow.add(segmentValue)
                }
            }

            if (!foundSegments) {
                // Whole barcode may be a part number; try to interpret it below.
                segments.partNo.add(value)
            }
        }

        return segments
    }

    private val PART_NO_LABEL_PATTERNS = listOf(
        Pattern.compile("\\(P\\)CUSTOMER\\s+P/N:\\s*([A-Z0-9\\- ]+)"),
        Pattern.compile("\\(1P\\)MPN:\\s*([A-Z0-9\\- ]+)"),
        Pattern.compile("\\b(?:PN|PART\\s+NO|PART\\s+#|P/N|MPN|TYPE|CODE)\\s*[:\\s]+([A-Z0-9\\- ]+)"),
    )

    fun extractPartNoCandidates(text: String, barcodes: List<OcrBarcode>): List<String> {
        val candidates = ArrayList<String>()
        val barcodeSegments = parseBarcodeSegments(barcodes)

        // Barcode segments first (GS1-style part numbers)
        for (value in barcodeSegments.partNo) {
            val stripped = stripSupplierPrefixes(value)
            if (looksLikePartNumber(stripped)) {
                candidates.add(stripped)
            }
        }

        val normalizedText = normalizeText(text)

        // Explicit labels
        for (pattern in PART_NO_LABEL_PATTERNS) {
            val values = extractWithRegex(normalizedText, pattern)
            for (value in values) {
                val stripped = stripSupplierPrefixes(value)
                if (looksLikePartNumber(stripped)) {
                    candidates.add(stripped)
                }
            }
        }

        // Fallback: any token that looks like a part number
        val tokens = normalizedText.split(Regex("[^A-Z0-9\\-]+"))
        for (token in tokens) {
            if (looksLikePartNumber(token)) {
                candidates.add(stripSupplierPrefixes(token))
            }
        }

        // Also try joining adjacent short tokens that may have been split (e.g. 'RK73H1ETTP 1001F')
        val words = normalizedText.split(Regex("\\s+"))
        for (i in 0 until words.size - 1) {
            val joined = words[i] + words[i + 1]
            if (looksLikePartNumber(joined)) {
                candidates.add(stripSupplierPrefixes(joined))
            }
        }

        return candidates.map { collapseSpaces(it) }.distinct()
    }

    private val QTY_LABEL_REGEX = Pattern.compile("\\b(?:QTY|QUANTITY|Q)\\s*[:\\s]+(\\d+)")
    private val QTY_UNIT_REGEX = Pattern.compile("\\b(\\d+)\\s*(?:PCS|PC|EA|EA\\.?|QTY|QUANTITY|Q)\\b")
    private val PURE_DIGITS = Regex("^\\d+$")
    private val Q_PREFIX_DIGITS = Regex("^Q(\\d+)$")
    private val BARE_QTY_REGEX = Pattern.compile("\\b(\\d{2,})\\b")

    /** Web's `Number(v)` + `Number.isInteger(n) && n > 0`, bounded to Int (candidates are List<Int>). */
    private fun positiveInt(value: String): Int? =
        value.toLongOrNull()?.takeIf { it in 1..Int.MAX_VALUE.toLong() }?.toInt()

    fun extractQtyCandidates(text: String, barcodes: List<OcrBarcode>): List<Int> {
        val values = ArrayList<Int>()
        val barcodeSegments = parseBarcodeSegments(barcodes)
        val normalizedText = normalizeText(text)

        // Explicit quantity labels
        val explicit = extractWithRegex(normalizedText, QTY_LABEL_REGEX)
        for (v in explicit) {
            val n = positiveInt(v)
            if (n != null) values.add(n)
        }

        // Number followed by units
        val unitMatches = extractWithRegex(normalizedText, QTY_UNIT_REGEX)
        for (v in unitMatches) {
            val n = positiveInt(v)
            if (n != null && n !in values) values.add(n)
        }

        // Barcode segments and whole-barcode values
        for (segment in barcodeSegments.qty) {
            val n = positiveInt(collapseSpaces(segment))
            if (n != null && n !in values) values.add(n)
        }

        for (barcode in barcodes) {
            val value = normalizeText(barcode.value)
            if (PURE_DIGITS.matches(value)) {
                val n = positiveInt(value)
                if (n != null && n !in values) values.add(n)
                continue
            }
            val qMatch = Q_PREFIX_DIGITS.matchEntire(value)
            if (qMatch != null) {
                val n = positiveInt(qMatch.groupValues[1])
                if (n != null && n !in values) values.add(n)
            }
        }

        // Fallback: any bare 2+ digit integer
        val bareMatches = extractWithRegex(normalizedText, BARE_QTY_REGEX)
        for (v in bareMatches) {
            val n = positiveInt(v)
            if (n != null && n !in values) values.add(n)
        }

        return values
    }

    private val DATE_CODE_LABEL_REGEX =
        Pattern.compile("\\b(?:DATE\\s*CODE?|DT|MFG\\s*DATE|DATE)\\s*[:\\s]*([A-Z0-9\\-]+)")
    private val ISO_DATE_REGEX = Pattern.compile("\\b(\\d{4}-\\d{2}-\\d{2})\\b")
    private val BARE_DATE_REGEX = Pattern.compile("\\b(\\d{4,8})\\b")

    fun extractDateCodeCandidates(text: String, barcodes: List<OcrBarcode>): List<String> {
        val values = ArrayList<String>()
        val barcodeSegments = parseBarcodeSegments(barcodes)
        val normalizedText = normalizeText(text)

        // Explicit labels
        val explicit = extractWithRegex(normalizedText, DATE_CODE_LABEL_REGEX)
        for (v in explicit) {
            val cleaned = collapseSpaces(v)
            if (cleaned.length in 2..12) values.add(cleaned)
        }

        // Barcode date identifiers
        for (segment in barcodeSegments.dateCode) {
            val cleaned = collapseSpaces(segment)
            if (cleaned.length in 2..12 && cleaned !in values) {
                values.add(cleaned)
            }
        }

        // ISO-like dates: 2025-10-29
        val isoMatches = extractWithRegex(normalizedText, ISO_DATE_REGEX)
        for (v in isoMatches) {
            val cleaned = collapseSpaces(v)
            if (cleaned !in values) values.add(cleaned)
        }

        // Bare 4-8 digit sequences that could be date codes
        val bareMatches = extractWithRegex(normalizedText, BARE_DATE_REGEX)
        for (v in bareMatches) {
            if (v !in values) values.add(v)
        }

        return values
    }

    private fun isPartNumberToken(token: String, partNo: String): Boolean {
        val normalizedToken = collapseSpaces(token)
        val normalizedPartNo = collapseSpaces(normalizeText(partNo))
        return normalizedToken == normalizedPartNo ||
            normalizedPartNo.contains(normalizedToken) ||
            normalizedToken.contains(normalizedPartNo)
    }

    private val LOT_LABEL_REGEX =
        Pattern.compile("\\b(?:LOT\\s*NO?|LOT#|LOT|BATCH|TRACE\\s*CODE)\\s*[:\\s]*([A-Z0-9\\-]+)")
    private val TRACE_CODE_REGEX =
        Pattern.compile("\\(1T\\)\\s*TRACE\\s*CODE\\s*[:\\s]*([A-Z0-9\\-]+)")

    fun extractLotCodeCandidates(
        text: String,
        barcodes: List<OcrBarcode>,
        excludeItemId: String? = null,
    ): List<String> {
        val values = ArrayList<String>()
        val barcodeSegments = parseBarcodeSegments(barcodes)
        val normalizedText = normalizeText(text)

        val explicit = extractWithRegex(normalizedText, LOT_LABEL_REGEX)
        for (v in explicit) {
            val cleaned = collapseSpaces(v)
            if (cleaned.length >= 2) values.add(cleaned)
        }

        // KOA-style (1T) trace code
        val traceMatches = extractWithRegex(normalizedText, TRACE_CODE_REGEX)
        for (v in traceMatches) {
            val cleaned = collapseSpaces(v)
            if (cleaned.length >= 2 && cleaned !in values) values.add(cleaned)
        }

        // Barcode lot identifiers
        for (segment in barcodeSegments.lotCode) {
            val cleaned = collapseSpaces(segment)
            if (cleaned.length >= 2 && cleaned !in values) values.add(cleaned)
        }

        // Fallback: alphanumeric tokens that are not substrings of the matched part number
        val tokens = normalizedText.split(Regex("[^A-Z0-9\\-]+"))
        for (token in tokens) {
            val cleaned = collapseSpaces(token)
            if (cleaned.length in 4..30 &&
                cleaned.any { it in 'A'..'Z' } &&
                cleaned.any { it in '0'..'9' } &&
                (excludeItemId == null || !isPartNumberToken(cleaned, excludeItemId)) &&
                cleaned !in values
            ) {
                values.add(cleaned)
            }
        }

        return values
    }

    private val COO_CODE_REGEX =
        Pattern.compile("\\b(?:COO|COUNTRY\\s+OF\\s+ORIGIN)\\s*[:\\s]+([A-Z]{2,3})\\b")
    private val MADE_IN_REGEX = Pattern.compile(
        "\\bMADE\\s+IN\\s+([A-Z]{2,}|CHINA|SLOVENIA|JAPAN|INDIA|GERMANY|KOREA|MALAYSIA|INDONESIA|TAIWAN|THAILAND|VIETNAM|USA|AMERICA|SINGAPORE|PHILIPPINES)",
    )

    fun extractCooCandidates(text: String, barcodes: List<OcrBarcode>): List<String> {
        val values = ArrayList<String>()
        val barcodeSegments = parseBarcodeSegments(barcodes)
        val normalizedText = normalizeText(text)

        // 2-3 letter code
        val codeMatches = extractWithRegex(normalizedText, COO_CODE_REGEX)
        for (v in codeMatches) {
            if (v !in values) values.add(v)
        }

        // Made in ...
        val madeInMatches = extractWithRegex(normalizedText, MADE_IN_REGEX)
        for (v in madeInMatches) {
            val upper = v.uppercase()
            val code = COUNTRY_NAME_TO_CODE[collapseSpaces(upper)]
            if (code != null && code !in values) values.add(code)
            if (upper !in values) values.add(upper)
        }

        // Barcode COO identifiers
        for (segment in barcodeSegments.coo) {
            val cleaned = collapseSpaces(segment)
            if (cleaned.length >= 2 && cleaned !in values) values.add(cleaned)
        }

        return values
    }

    private val COW_LABEL_REGEX =
        Pattern.compile("\\b(?:COW|COW\\s*CODE?)\\s*[:\\s]*([A-Z0-9\\-]+)")

    fun extractCowCandidates(text: String, barcodes: List<OcrBarcode>): List<String> {
        val values = ArrayList<String>()
        val barcodeSegments = parseBarcodeSegments(barcodes)
        val normalizedText = normalizeText(text)

        val explicit = extractWithRegex(normalizedText, COW_LABEL_REGEX)
        for (v in explicit) {
            val cleaned = collapseSpaces(v)
            if (cleaned.isNotEmpty()) values.add(cleaned)
        }

        for (segment in barcodeSegments.cow) {
            val cleaned = collapseSpaces(segment)
            if (cleaned.isNotEmpty() && cleaned !in values) values.add(cleaned)
        }

        return values
    }

    fun scoreTargetMatch(target: String, candidates: List<String>): Int {
        val normalizedTarget = collapseSpaces(normalizeText(target))
        val targetVariants = generateVariants(normalizedTarget)

        var bestScore = 0

        for (candidate in candidates) {
            val normalizedCandidate = collapseSpaces(normalizeText(candidate))

            // Exact match
            if (normalizedCandidate == normalizedTarget) {
                bestScore = maxOf(bestScore, 100)
                continue
            }

            // Match after stripping common prefixes
            val strippedCandidate = stripSupplierPrefixes(normalizedCandidate)
            if (strippedCandidate == normalizedTarget) {
                bestScore = maxOf(bestScore, 95)
                continue
            }

            // Variant match (O/0, I/1, etc.)
            val candidateVariants = generateVariants(normalizedCandidate)
            val variantMatch = candidateVariants.any { cv -> targetVariants.any { tv -> cv == tv } }
            if (variantMatch) {
                bestScore = maxOf(bestScore, 80)
                continue
            }

            // Contains / contained
            if (normalizedCandidate.contains(normalizedTarget) ||
                normalizedTarget.contains(normalizedCandidate)
            ) {
                bestScore = maxOf(bestScore, 50)
            }
        }

        return bestScore
    }

    fun findBestItemMatches(targets: List<String>, candidates: List<String>): List<String> {
        // sortedByDescending is stable, matching V8's stable Array.sort
        return targets
            .map { it to scoreTargetMatch(it, candidates) }
            .sortedByDescending { it.second }
            .filter { it.second > 0 }
            .map { it.first }
    }

    /**
     * Parse a scanned label and identify which target part number it most likely represents.
     *
     * Matching priority:
     * 1. Barcodes / QR codes (exact, then stripped of supplier prefixes).
     * 2. OCR text (explicit labels, then token fallback, with OCR-error variants).
     *
     * When a part number is found, qty / COO / date code / lot code / COW candidates are
     * extracted from both barcodes and OCR text. Every candidate is returned in `options`;
     * `parsed` contains the best single guess for each field.
     *
     * Web accepts a string or string[] for targets; Kotlin takes a list only (empty = no gate).
     */
    fun parseAndIdentify(raw: RawOcrCapture, targets: List<String> = emptyList()): OcrParseResult {
        val normalizedTargets = targets.map { normalizeText(it) }

        val partNoCandidates = extractPartNoCandidates(raw.text, raw.barcodes)
        val rankedItemIds = findBestItemMatches(normalizedTargets, partNoCandidates)

        val matched = rankedItemIds.isNotEmpty()
        val bestItemId = rankedItemIds.firstOrNull()

        val qtys = extractQtyCandidates(raw.text, raw.barcodes)
        val coos = extractCooCandidates(raw.text, raw.barcodes)
        val dateCodes = extractDateCodeCandidates(raw.text, raw.barcodes)
        val lotCodes = extractLotCodeCandidates(raw.text, raw.barcodes, bestItemId)
        val cows = extractCowCandidates(raw.text, raw.barcodes)

        return OcrParseResult(
            matched = matched,
            parsed = ParsedFields(
                itemId = bestItemId,
                qty = qtys.firstOrNull(),
                coo = coos.firstOrNull(),
                dateCode = dateCodes.firstOrNull(),
                lotCode = lotCodes.firstOrNull(),
                cow = cows.firstOrNull(),
            ),
            options = CandidateOptions(
                itemIds = rankedItemIds,
                qtys = qtys,
                coos = coos,
                dateCodes = dateCodes,
                lotCodes = lotCodes,
                cows = cows,
            ),
            raw = raw,
        )
    }
}
