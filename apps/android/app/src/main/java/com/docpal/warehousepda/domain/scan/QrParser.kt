package com.docpal.warehousepda.domain.scan

import java.util.regex.Pattern

/** Port of decodeKoaQty + parseQrCapture from apps/web/utils/parseOcrScan.ts. */
object QrParser {

    private const val QTY_ENCODING_KOA_ZEROS = "koa_zeros"

    data class SupplierQrcodeTemplate(
        val code: String,
        val qrcodeTemplate: String,
        val qrcodeQtyEncoding: String?,
    )

    fun decodeKoaQty(encoded: String): Int? {
        if (!encoded.all { it.isDigit() }) return null
        if (encoded.length < 2) return null
        val zeroCount = encoded.last().digitToInt()
        val prefix = encoded.dropLast(1).toLongOrNull() ?: return null
        var result = prefix
        repeat(zeroCount) { result *= 10 }
        if (result <= 0 || result > Int.MAX_VALUE) return null
        return result.toInt()
    }

    /**
     * @param targets empty list = no gate (matches any itemId)
     * @return matched result, or null when no template matched (caller falls back to OcrLabelParser.parseAndIdentify)
     */
    fun parseQrCapture(
        qrValue: String,
        supplierTemplates: List<SupplierQrcodeTemplate>,
        targets: List<String>,
        contextSupplierCode: String?,
    ): OcrLabelParser.OcrParseResult? {
        val normalizedQr = qrValue.trim()
        val ordered = if (contextSupplierCode != null) {
            supplierTemplates.sortedByDescending { it.code == contextSupplierCode }
        } else supplierTemplates

        for (supplier in ordered) {
            val regex = NamedGroupRegex.compile(supplier.qrcodeTemplate) ?: continue
            val groups = regex.matchGroups(normalizedQr) ?: continue
            val itemId = groups["itemId"] ?: continue
            val normalizedItemId = ScanPrimitives.collapseSpaces(itemId.uppercase())
            val itemMatch = targets.isEmpty() || targets.any {
                ScanPrimitives.collapseSpaces(it.uppercase()) == normalizedItemId
            }
            if (!itemMatch) continue

            val qtyGroup = groups["qty"]
            val qty: Int? = when {
                qtyGroup == null -> null
                supplier.qrcodeQtyEncoding == QTY_ENCODING_KOA_ZEROS -> decodeKoaQty(qtyGroup)
                else -> qtyGroup.toIntOrNull()?.takeIf { it > 0 }
            }

            return OcrLabelParser.OcrParseResult(
                matched = true,
                parsed = OcrLabelParser.ParsedFields(
                    itemId = normalizedItemId,
                    qty = qty,
                    coo = groups["coo"],
                    dateCode = groups["dateCode"],
                    lotCode = groups["lotCode"],
                    cow = groups["cow"],
                ),
                options = OcrLabelParser.CandidateOptions(
                    itemIds = listOf(normalizedItemId),
                    qtys = listOfNotNull(qty),
                    coos = listOfNotNull(groups["coo"]),
                    dateCodes = listOfNotNull(groups["dateCode"]),
                    lotCodes = listOfNotNull(groups["lotCode"]),
                    cows = listOfNotNull(groups["cow"]),
                ),
                raw = OcrLabelParser.RawOcrCapture(text = qrValue, barcodes = emptyList()),
            )
        }
        return null
    }
}

/**
 * Named-group regex shim. `Matcher.group(String)` requires API 26 but minSdk is 24,
 * so `(?<name>...)` groups are resolved by position instead: names are recorded in
 * order of appearance and the pattern is rewritten to plain capturing groups.
 * Invalid patterns return null (web skips invalid template regexes).
 */
class NamedGroupRegex private constructor(
    private val pattern: Pattern,
    private val names: List<String?>,   // null = unnamed capturing group
) {
    fun matchGroups(value: String): Map<String, String>? {
        val matcher = pattern.matcher(value)
        if (!matcher.find()) return null
        val result = HashMap<String, String>()
        names.forEachIndexed { index, name ->
            if (name == null) return@forEachIndexed
            // An optional group that didn't participate returns null; store it as
            // absent (callers treat missing keys as "not captured"), never as null.
            val value = matcher.group(index + 1) ?: return@forEachIndexed
            result[name] = value
        }
        return result
    }

    companion object {
        /**
         * Rewrites `(?<name>` openers to plain `(` and records every capturing group
         * in order (null = unnamed). Non-capturing/lookaround openers (?:, ?=, ?!, ?<=, ?<!)
         * are left alone and not counted. Seeded templates have no escaped `\(` or
         * char-class parens; the seeded KOA template is all-named anyway.
         */
        fun compile(template: String): NamedGroupRegex? {
            val names = ArrayList<String?>()
            val rewritten = StringBuilder()
            var i = 0
            while (i < template.length) {
                val c = template[i]
                if (c == '\\' && i + 1 < template.length) {
                    rewritten.append(template, i, i + 2)
                    i += 2
                    continue
                }
                if (c == '(') {
                    if (template.startsWith("(?<", i)) {
                        val close = template.indexOf('>', i + 3)
                        if (close > 0 && !template.startsWith("(?<=", i) && !template.startsWith("(?<!", i)) {
                            names.add(template.substring(i + 3, close))
                            rewritten.append('(')
                            i = close + 1
                            continue
                        }
                    } else if (!template.startsWith("(?:", i) && !template.startsWith("(?=", i)
                        && !template.startsWith("(?!", i)
                    ) {
                        names.add(null)   // unnamed capturing group — counts toward indexes
                    }
                }
                rewritten.append(c)
                i++
            }
            return try {
                NamedGroupRegex(Pattern.compile(rewritten.toString()), names)
            } catch (e: Exception) {
                null
            }
        }
    }
}
