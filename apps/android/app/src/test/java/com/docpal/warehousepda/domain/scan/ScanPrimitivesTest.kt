package com.docpal.warehousepda.domain.scan

import com.docpal.warehousepda.domain.LocalizedException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ScanPrimitivesTest {

    @Test fun `normalize trims, uppercases, collapses whitespace, keeps dashes`() {
        assertEquals("KOA-103", ScanPrimitives.normalize("  koa-103  "))
        assertEquals("A B", ScanPrimitives.normalize("a\t b\n c".replace(" c", "")))
        assertEquals("IC-LM358DR", ScanPrimitives.normalize("ic-lm358dr"))
    }

    @Test fun `normalizeCode applies OCR digit substitutions`() {
        assertEquals("2406", ScanPrimitives.normalizeCode("24O6"))
        assertEquals("1125", ScanPrimitives.normalizeCode("ILZS"))
        assertEquals("L240603".replace("L", "1"), ScanPrimitives.normalizeCode("L2406O3"))
    }

    @Test fun `collapseSpaces removes all whitespace`() {
        assertEquals("ABCD", ScanPrimitives.collapseSpaces(" A B\nC\tD "))
    }

    @Test fun `parseManual normalizes fields and nulls empties`() {
        val p = ScanPrimitives.parseManual(
            ScanPrimitives.OcrInput(partNo = " koa-103 ", dateCode = "24O6", lotCode = "", coo = "my", cow = "", qty = "400")
        )
        assertEquals("KOA-103", p.partNo)
        assertEquals("2406", p.dateCode)
        assertNull(p.lotCode)
        assertEquals("MY", p.coo)
        assertNull(p.cow)
        assertEquals(400, p.qty)
    }

    @Test fun `parseManual rejects non-positive or fractional qty`() {
        for (bad in listOf("0", "-5", "1.5", "abc", "")) {
            val e = assertThrows(LocalizedException::class.java) {
                ScanPrimitives.parseManual(ScanPrimitives.OcrInput("X", "", "", "", "", bad))
            }
            assertEquals("qty_must_be_positive_integer", e.code)
        }
    }
}
