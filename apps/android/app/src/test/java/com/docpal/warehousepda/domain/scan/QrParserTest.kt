package com.docpal.warehousepda.domain.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QrParserTest {

    @Test fun `decodeKoaQty`() {
        assertEquals(5000, QrParser.decodeKoaQty("53"))     // prefix 5, 3 zeros
        assertEquals(5, QrParser.decodeKoaQty("50"))
        assertNull(QrParser.decodeKoaQty("5"))              // too short
        assertNull(QrParser.decodeKoaQty("5a3"))            // non-digit
        assertNull(QrParser.decodeKoaQty("03"))             // result 0 -> invalid
    }

    private val koaTemplate = QrParser.SupplierQrcodeTemplate(
        code = "KOA",
        // verbatim from seed.sql suppliers row (KOA is the only seeded template)
        qrcodeTemplate = "^:(?<itemId>[^:]+)::(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<ignore2>[^:]+):(?<fullName>.+)$",
        qrcodeQtyEncoding = "koa_zeros",
    )

    private val koaSample = ":RK73H1ETTP1000F::24:X:9827002:602:KOA+RK73H1ETTP1000F::::"

    @Test fun `parseQrCapture matches KOA template and decodes qty`() {
        val result = QrParser.parseQrCapture(
            qrValue = koaSample,
            supplierTemplates = listOf(koaTemplate),
            targets = emptyList(),
            contextSupplierCode = "KOA",
        )!!
        assertTrue(result.matched)
        assertEquals("RK73H1ETTP1000F", result.parsed.itemId)
        assertEquals(20000, result.parsed.qty)          // "24" -> 2 * 10^4
        assertEquals("9827002", result.parsed.lotCode)
        assertEquals(listOf(20000), result.options.qtys)
    }

    @Test fun `targets gate uses collapseSpaces + uppercase exact match`() {
        val hit = QrParser.parseQrCapture(koaSample, listOf(koaTemplate),
            targets = listOf(" rk73h1ettp1000f "), contextSupplierCode = null)
        assertTrue(hit != null && hit.matched)
        val miss = QrParser.parseQrCapture(koaSample, listOf(koaTemplate),
            targets = listOf("unrelated-part"), contextSupplierCode = null)
        assertNull(miss)   // no template match -> caller falls back to parseAndIdentify
    }

    @Test fun `context supplier template is tried first`() {
        val other = koaTemplate.copy(code = "ZZZ")
        // both templates match the sample; context code decides which one wins —
        // with ZZZ context, the ZZZ copy must be the one that returns (same decode here,
        // so assert via a qty-encoding difference).
        val zzzPlain = other.copy(qrcodeQtyEncoding = null)
        val result = QrParser.parseQrCapture(koaSample, listOf(koaTemplate, zzzPlain),
            targets = emptyList(), contextSupplierCode = "ZZZ")!!
        assertEquals(24, result.parsed.qty)   // plain parseInt, not koa_zeros decode
    }

    @Test fun `invalid template regex is skipped`() {
        val broken = koaTemplate.copy(qrcodeTemplate = "(?<itemId>[unclosed")
        assertNull(QrParser.parseQrCapture(koaSample, listOf(broken), emptyList(), null))
        // a valid template after the broken one still matches:
        val result = QrParser.parseQrCapture(koaSample, listOf(broken, koaTemplate), emptyList(), null)
        assertEquals("RK73H1ETTP1000F", result!!.parsed.itemId)
    }

    @Test fun `named group regex handles unnamed groups by position`() {
        val regex = NamedGroupRegex.compile("^(\\d+):(?<itemId>[^:]+):(?<qty>\\d+)$")!!
        val groups = regex.matchGroups("42:ABC:7")!!
        assertEquals("ABC", groups["itemId"])
        assertEquals("7", groups["qty"])
    }
}
