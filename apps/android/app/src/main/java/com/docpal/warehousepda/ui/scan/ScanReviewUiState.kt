package com.docpal.warehousepda.ui.scan

import com.docpal.warehousepda.domain.scan.OcrLabelParser
import com.docpal.warehousepda.domain.scan.ScanMatcher
import com.docpal.warehousepda.domain.scan.ScanPrimitives

/** A selectable match rendered in the review dialog. */
data class ScanMatchOption(val id: String, val label: String)

/** State of the label scan review dialog (port of LabelScanReviewModal.vue props). */
data class ScanReviewUiState(
    val manual: Boolean,              // manual entry vs camera review (web mode)
    val imagePath: String?,
    val fields: ScanPrimitives.OcrInput,
    val options: OcrLabelParser.CandidateOptions,
    val matching: Boolean = false,
    val applying: Boolean = false,
    val matchOptions: List<ScanMatchOption> = emptyList(),
    // R.string.scan_review_match_single / _multiple / _none / _error; null = not matched yet.
    val matchMessageRes: Int? = null,
    val matchErrorKey: String? = null,
    val applyErrorKey: String? = null,
)

// Scan seams moved here from ReceivingDetailViewModel so the picking flow (and later
// put-away) can reuse them alongside the generalized review dialog.

/** Matcher seam — lets VM tests substitute a fake for the lambda-built `ScanMatcher`. */
fun interface ScanMatchSource {
    suspend fun matchReceiving(
        ctx: ScanMatcher.ReceivingContext,
        parsed: ScanPrimitives.OcrInput,
        actorId: String?,
    ): ScanMatcher.MatchResult
}

/** Parse seam — QR template first, OCR fallback (real wiring lives in the factory). */
fun interface LabelScanParser {
    suspend fun parse(
        capture: OcrLabelParser.RawOcrCapture,
        targets: List<String>,
    ): OcrLabelParser.OcrParseResult
}
