package com.docpal.warehousepda.domain.scan

import com.docpal.warehousepda.domain.scan.OcrLabelParser.OcrBarcode
import com.docpal.warehousepda.domain.scan.OcrLabelParser.RawOcrCapture
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Case-by-case port of the `parseAndIdentify` describe block in
 * apps/web/tests/parseOcrScan.test.ts (17 cases). The `decodeKoaQty` (4) and
 * `parseQrCapture` (8) cases are not ported here — they live in QrParserTest
 * (QrParser.parseQrCapture returns null on no template match instead of
 * falling back internally, so the fallback cases don't apply to this parser).
 */
class OcrLabelParserTest {

    @Test fun `matches a part number from a barcode value`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "some noisy text",
                barcodes = listOf(OcrBarcode(value = "RK73B1JTTD181G", format = "CODE_128")),
            ),
            listOf("RK73B1JTTD181G", "S-1206B18-M3T1U"),
        )

        assertTrue(result.matched)
        assertEquals("RK73B1JTTD181G", result.parsed.itemId)
        assertTrue(result.options.itemIds.contains("RK73B1JTTD181G"))
    }

    @Test fun `strips supplier prefixes like KOA from barcode values`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "",
                barcodes = listOf(OcrBarcode(value = "KOA+RK73B1JTTD181G", format = "CODE_128")),
            ),
            listOf("RK73B1JTTD181G"),
        )

        assertTrue(result.matched)
        assertEquals("RK73B1JTTD181G", result.parsed.itemId)
    }

    @Test fun `matches a part number from OCR text`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "(P)CUSTOMER P/N: RK73B1JTTD181G\n(Q)QUANTITY: 5000",
                barcodes = emptyList(),
            ),
            listOf("RK73B1JTTD181G"),
        )

        assertTrue(result.matched)
        assertEquals("RK73B1JTTD181G", result.parsed.itemId)
    }

    @Test fun `joins a part number split by spaces in OCR text`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "(P)CUSTOMER P/N: KOA+RK73H1ETTP 1001F",
                barcodes = emptyList(),
            ),
            listOf("RK73H1ETTP1001F"),
        )

        assertTrue(result.matched)
        assertEquals("RK73H1ETTP1001F", result.parsed.itemId)
    }

    @Test fun `matches OCR text with common digit letter substitution errors`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "TYPE: S-12O6B18-M3T1U", // O instead of 0
                barcodes = emptyList(),
            ),
            listOf("S-1206B18-M3T1U"),
        )

        assertTrue(result.matched)
        assertEquals("S-1206B18-M3T1U", result.parsed.itemId)
    }

    @Test fun `returns matched=false when no part number is found`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "RANDOM TEXT WITHOUT ANY MATCHING ID",
                barcodes = listOf(OcrBarcode(value = "NOTAMATCH", format = "CODE_128")),
            ),
            listOf("RK73B1JTTD181G"),
        )

        assertFalse(result.matched)
        assertNull(result.parsed.itemId)
    }

    @Test fun `extracts quantity candidates from labels and barcodes`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "QTY: 5000\n5000 pcs",
                barcodes = listOf(OcrBarcode(value = "Q5000", format = "CODE_128")),
            ),
            listOf("RK73B1JTTD181G"),
        )

        assertTrue(result.options.qtys.contains(5000))
    }

    @Test fun `extracts COO candidates including full country names`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "Made in Slovenia",
                barcodes = emptyList(),
            ),
            listOf("ZMY200B"),
        )

        val upper = result.options.coos.map { it.uppercase() }
        assertTrue(upper.contains("SI"))
        assertTrue(upper.contains("SLOVENIA"))
    }

    @Test fun `extracts date code candidates from labeled and bare values`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "DATE CODE: 2544\n201910",
                barcodes = emptyList(),
            ),
            listOf("RK73B1JTTD181G"),
        )

        assertTrue(result.options.dateCodes.contains("2544"))
        assertTrue(result.options.dateCodes.contains("201910"))
    }

    @Test fun `extracts lot code candidates from LOT and TRACE CODE labels`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "LOT: VTCJ9X17324-0134\n(1T)TRACE CODE: 9827T377-1",
                barcodes = emptyList(),
            ),
            listOf("S-1206B18-M3T1U"),
        )

        assertTrue(result.options.lotCodes.contains("VTCJ9X17324-0134"))
        assertTrue(result.options.lotCodes.contains("9827T377-1"))
    }

    @Test fun `ranks multiple target matches`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "TYPE: S-1206B18-M3T1U",
                barcodes = emptyList(),
            ),
            listOf("S-1206B18-M3T1U", "RK73B1JTTD181G"),
        )

        assertEquals("S-1206B18-M3T1U", result.options.itemIds[0])
    }

    @Test fun `accepts a single target (web passes a bare string, Kotlin a list of one)`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "RK73B1JTTD181G",
                barcodes = emptyList(),
            ),
            listOf("RK73B1JTTD181G"),
        )

        assertTrue(result.matched)
        assertEquals("RK73B1JTTD181G", result.parsed.itemId)
    }

    @Test fun `parses a GS1-style composite barcode`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "",
                barcodes = listOf(
                    OcrBarcode(value = "(P)RK73B1JTTD181G(Q)5000(D)2544", format = "DATA_MATRIX"),
                ),
            ),
            listOf("RK73B1JTTD181G"),
        )

        assertTrue(result.matched)
        assertTrue(result.options.qtys.contains(5000))
        assertTrue(result.options.dateCodes.contains("2544"))
    }

    @Test fun `extracts COO from a labeled code`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "COO: JP",
                barcodes = emptyList(),
            ),
            listOf("S-1206B18-M3T1U"),
        )

        assertTrue(result.options.coos.contains("JP"))
        assertEquals("JP", result.parsed.coo)
    }

    @Test fun `extracts COW from text`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "COW: W1-2024A",
                barcodes = emptyList(),
            ),
            listOf("RK73B1JTTD181G"),
        )

        assertTrue(result.options.cows.contains("W1-2024A"))
        assertEquals("W1-2024A", result.parsed.cow)
    }

    @Test fun `returns empty options when no fields are present`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "",
                barcodes = emptyList(),
            ),
            listOf("RK73B1JTTD181G"),
        )

        assertFalse(result.matched)
        assertEquals(emptyList<String>(), result.options.itemIds)
        assertEquals(emptyList<Int>(), result.options.qtys)
        assertEquals("", result.raw.text)
    }

    @Test fun `extracts unlabeled qty, date, and lot from a minimal label`() {
        val result = OcrLabelParser.parseAndIdentify(
            RawOcrCapture(
                text = "ZMY200B\n5000\n2025-10-29\nS12235\nMade in Slovenia",
                barcodes = emptyList(),
            ),
            listOf("ZMY200B", "RK73B1JTTD181G"),
        )

        assertTrue(result.matched)
        assertEquals("ZMY200B", result.parsed.itemId)
        assertTrue(result.options.qtys.contains(5000))
        assertTrue(result.options.dateCodes.contains("2025-10-29"))
        assertTrue(result.options.lotCodes.contains("S12235"))
        assertTrue(result.options.coos.map { it.uppercase() }.contains("SI"))
    }
}
