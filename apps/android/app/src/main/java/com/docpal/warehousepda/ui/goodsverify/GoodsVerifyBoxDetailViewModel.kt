package com.docpal.warehousepda.ui.goodsverify

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.AppContainer
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.VerifyBoxDetail
import com.docpal.warehousepda.domain.model.VerifyBoxItem
import com.docpal.warehousepda.domain.scan.OcrLabelParser
import com.docpal.warehousepda.domain.scan.QrParser
import com.docpal.warehousepda.domain.scan.ScanMatcher
import com.docpal.warehousepda.domain.scan.ScanPrimitives
import com.docpal.warehousepda.ui.receiving.CameraScanResult
import com.docpal.warehousepda.ui.receiving.SessionSource
import com.docpal.warehousepda.ui.scan.LabelScanParser
import com.docpal.warehousepda.ui.scan.ScanMatchOption
import com.docpal.warehousepda.ui.scan.ScanReviewUiState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Read/mutation slice of `GoodsVerifyRepository` the box detail screen needs. */
interface GoodsVerifyBoxDetailSource {
    suspend fun getBoxDetail(boxId: String): VerifyBoxDetail?

    /** Scan-to-verify (Task 8) — `GoodsVerifyRepository.verifyBoxItem`. */
    suspend fun verifyItem(boxId: String, partId: String)
    suspend fun markBoxVerified(boxId: String, actorId: String)
}

data class GoodsVerifyBoxDetailUiState(
    val loading: Boolean = true,
    val detail: VerifyBoxDetail? = null,
    val errorKey: String? = null,
    // LocalizedException.params, passed as %1$s format args when errorKey renders.
    val errorArgs: List<String> = emptyList(),
    val actionInProgress: Boolean = false,
    // Scan-to-verify (Task 8): review dialog.
    val scanReview: ScanReviewUiState? = null,
    val dialogOpen: Boolean = false,
) {
    /** Web: mark-verified shows only for an unverified box whose items are all verified. */
    val canMarkVerified: Boolean get() =
        detail != null && detail.status != "verified" && detail.allVerified
}

/**
 * Loads the box detail in `init` (the first query must be testable without Compose);
 * the screen still calls [reload] via OnResumeEffect. Scan-to-verify mirrors
 * PutAwayDetailViewModel's Task 10 hardening, minus the pin/toast machinery
 * (targets come from the box's unverified items; every match is confirmed in
 * the review dialog — web confirmSingleMatch).
 */
class GoodsVerifyBoxDetailViewModel(
    private val boxId: String,
    private val source: GoodsVerifyBoxDetailSource,
    private val sessionSource: SessionSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val labelScanParser: LabelScanParser = LabelScanParser { capture, targets ->
        OcrLabelParser.parseAndIdentify(capture, targets)
    },
) : ViewModel() {

    private val _uiState = MutableStateFlow(GoodsVerifyBoxDetailUiState())
    val uiState: StateFlow<GoodsVerifyBoxDetailUiState> = _uiState.asStateFlow()

    private var loadJob: Job? = null

    /** Last matchGoodsVerify result — `applyScan` resolves dialog option ids against it. */
    private var lastMatch: ScanMatcher.GoodsVerifyMatchResult? = null

    /**
     * Transient guard (NOT UiState): rejects a second scan while a parse is in flight,
     * so two scans can't interleave. Released the moment dialogOpen takes over as
     * the gate; cleared on every terminal path by construction.
     */
    private var scanInFlight = false

    init {
        reload()
    }

    fun reload(): Job {
        loadJob?.cancel()
        val job = viewModelScope.launch {
            _uiState.update { it.copy(loading = true) }
            try {
                val detail = withContext(io) { source.getBoxDetail(boxId) }
                _uiState.update {
                    it.copy(loading = false, detail = detail, errorKey = null, errorArgs = emptyList())
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: LocalizedException) {
                _uiState.update {
                    it.copy(loading = false, errorKey = e.code, errorArgs = e.params.values.toList())
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(loading = false) }
            }
        }
        loadJob = job
        return job
    }

    /** Web markVerified: no confirm, no success toast — the card--done flip is the feedback. */
    fun markVerified() = runAction { actorId -> source.markBoxVerified(boxId, actorId) }

    // --- Scan-to-verify -----------------------------------------------------------

    /** Camera scan result: parse (QR template → OCR fallback), then open the review dialog. */
    fun onCameraScan(result: CameraScanResult) {
        if (_uiState.value.dialogOpen || scanInFlight) return
        scanInFlight = true
        viewModelScope.launch {
            try {
                // Web scanTargets: the raw partNos of the box's UNVERIFIED items
                // (the parsers normalize them internally).
                val targets = _uiState.value.detail?.items.orEmpty()
                    .filter { !it.verified }
                    .map { it.partNo }
                val capture = OcrLabelParser.RawOcrCapture(
                    result.rawText,
                    result.barcodes.map { OcrLabelParser.OcrBarcode(it.value, it.format) },
                )
                val parsed = withContext(io) { labelScanParser.parse(capture, targets) }
                val fields = parsed.parsed.toOcrInput()
                // openScanReview releases the in-flight gate — dialogOpen takes over.
                dispatchMatch(fields, result.imagePath)
            } catch (e: CancellationException) {
                scanInFlight = false
                throw e
            } catch (e: LocalizedException) {
                scanInFlight = false
                _uiState.update {
                    it.copy(errorKey = e.code, errorArgs = e.params.values.toList())
                }
            } catch (e: Exception) {
                scanInFlight = false
                // Parsing does Room I/O (templates) — surface failures.
                _uiState.update { it.copy(errorKey = "scan_parse_failed") }
            }
        }
    }

    /**
     * Goods-verify flow (web confirmSingleMatch): both a single match and a match
     * error open the review dialog — nothing auto-applies.
     */
    private fun dispatchMatch(fields: ScanPrimitives.OcrInput, imagePath: String?) {
        val result = PURE_MATCHER.matchGoodsVerify(
            unverifiedTargets(), fields, sessionSource.currentUser()?.id,
        )
        openScanReview(fields, imagePath, result)
    }

    /** The box's unverified items as matcher targets (pre-normalized, per the matcher's contract). */
    private fun unverifiedTargets(): List<ScanMatcher.GoodsVerifyTarget> =
        _uiState.value.detail?.items.orEmpty()
            .filter { !it.verified }
            .map { toTarget(it) }

    private fun openScanReview(
        fields: ScanPrimitives.OcrInput,
        imagePath: String?,
        result: ScanMatcher.GoodsVerifyMatchResult,
    ) {
        lastMatch = result
        val review = when (result) {
            is ScanMatcher.GoodsVerifyMatchResult.Single -> ScanReviewUiState(
                // Camera captures carry an image (web review mode).
                manual = false,
                imagePath = imagePath,
                fields = fields,
                options = EMPTY_CANDIDATES,
                matchOptions = listOf(
                    ScanMatchOption(
                        id = result.item.partId,
                        label = "${result.item.partNo} (${result.item.qty})",
                    )
                ),
                matchMessageRes = R.string.scan_review_match_single,
            )
            is ScanMatcher.GoodsVerifyMatchResult.Error -> ScanReviewUiState(
                manual = imagePath == null,
                imagePath = imagePath,
                fields = fields,
                options = EMPTY_CANDIDATES,
                matchMessageRes = R.string.scan_review_error,
                matchErrorKey = result.key,
            )
        }
        // Raise dialogOpen at entry (no second parse can start while the dialog is
        // being built), then release the in-flight gate — dialogOpen is the gate
        // from here on.
        _uiState.update { it.copy(dialogOpen = true, scanReview = review) }
        scanInFlight = false
    }

    fun updateScanFields(fields: ScanPrimitives.OcrInput) = _uiState.update {
        it.copy(scanReview = it.scanReview?.copy(fields = fields))
    }

    /** Find match re-runs matchGoodsVerify against the CURRENT unverified targets with the edited fields. */
    fun findMatch() {
        val review = _uiState.value.scanReview ?: return
        if (review.matching) return
        viewModelScope.launch {
            _uiState.update { it.copy(scanReview = review.copy(matching = true, applyErrorKey = null)) }
            // matchGoodsVerify is pure — no io hop; the launch keeps the matching state observable.
            val result = PURE_MATCHER.matchGoodsVerify(
                unverifiedTargets(), review.fields, sessionSource.currentUser()?.id,
            )
            applyMatchResult(result)
        }
    }

    /** Maps a matchGoodsVerify result onto the review dialog's single-option/error state. */
    private fun applyMatchResult(result: ScanMatcher.GoodsVerifyMatchResult) {
        // A closeScanReview() racing an in-flight findMatch leaves scanReview null;
        // don't let lastMatch outlive its dialog.
        if (_uiState.value.scanReview == null) return
        lastMatch = result
        val options: List<ScanMatchOption>
        val messageRes: Int
        val errorKey: String?
        when (result) {
            is ScanMatcher.GoodsVerifyMatchResult.Single -> {
                options = listOf(
                    ScanMatchOption(
                        id = result.item.partId,
                        label = "${result.item.partNo} (${result.item.qty})",
                    )
                )
                messageRes = R.string.scan_review_match_single
                errorKey = null
            }
            is ScanMatcher.GoodsVerifyMatchResult.Error -> {
                options = emptyList()
                messageRes = R.string.scan_review_error
                errorKey = result.key
            }
        }
        _uiState.update {
            it.copy(
                scanReview = it.scanReview?.copy(
                    matching = false,
                    matchOptions = options,
                    matchMessageRes = messageRes,
                    matchErrorKey = errorKey,
                ),
            )
        }
    }

    /** Applies the dialog's single match — verifyItem for the matched part. */
    fun applyScan(optionId: String) {
        val review = _uiState.value.scanReview ?: return
        if (review.applying) return
        val single = (lastMatch as? ScanMatcher.GoodsVerifyMatchResult.Single) ?: return
        if (single.item.partId != optionId) return
        lastMatch = null
        _uiState.update { it.copy(scanReview = review.copy(applying = true, applyErrorKey = null)) }
        applyVerified(single.item)
    }

    fun retakeScan() {
        lastMatch = null
        _uiState.update { it.copy(scanReview = null, dialogOpen = false) }
    }

    fun closeScanReview() {
        lastMatch = null
        _uiState.update { it.copy(scanReview = null, dialogOpen = false) }
    }

    /** verifyItem dispatch (web matchGoodsVerify apply), wrapped in the shared action runner. */
    private fun applyVerified(item: ScanMatcher.GoodsVerifyTarget) {
        // Mirror runAction's serialization guard: when another action holds it,
        // runAction would no-op without a coroutine — release the scan gate here
        // so it can't strand.
        if (_uiState.value.actionInProgress) {
            scanInFlight = false
            return
        }
        runAction(scanApply = true, afterReload = ::autoMarkIfReady) {
            source.verifyItem(boxId, item.partId)
        }
    }

    /** Web onScanApplied: once the last item is verified, mark the box verified. */
    private fun autoMarkIfReady() {
        val detail = _uiState.value.detail ?: return
        if (!detail.allVerified || detail.status == "verified") return
        // On failure this surfaces errorKey (defensive — the check just passed).
        runAction { actorId -> source.markBoxVerified(boxId, actorId) }
    }

    private fun runAction(
        scanApply: Boolean = false,
        afterReload: (() -> Unit)? = null,
        block: suspend (actorId: String) -> Unit,
    ) {
        // Serialize actions so overlapping taps can't clobber each other's state.
        if (_uiState.value.actionInProgress) return
        viewModelScope.launch {
            _uiState.update { it.copy(actionInProgress = true, errorKey = null, errorArgs = emptyList()) }
            try {
                withContext(io) {
                    val actorId = sessionSource.currentUser()?.id
                        ?: throw LocalizedException("operator_not_signed_in")
                    block(actorId)
                }
                _uiState.update {
                    it.copy(
                        actionInProgress = false,
                        // A successful scan apply closes the dialog.
                        scanReview = if (scanApply) null else it.scanReview,
                        dialogOpen = if (scanApply) false else it.dialogOpen,
                    )
                }
                reload().join()
                afterReload?.invoke()
            } catch (e: CancellationException) {
                _uiState.update {
                    it.copy(
                        actionInProgress = false,
                        scanReview = if (scanApply) it.scanReview?.copy(applying = false) else it.scanReview,
                    )
                }
                throw e
            } catch (e: LocalizedException) {
                _uiState.update {
                    if (scanApply && it.scanReview != null) {
                        // Dialog apply: inline error, the dialog stays open.
                        it.copy(
                            actionInProgress = false,
                            scanReview = it.scanReview?.copy(applying = false, applyErrorKey = e.code),
                        )
                    } else {
                        it.copy(
                            actionInProgress = false,
                            errorKey = e.code,
                            errorArgs = e.params.values.toList(),
                        )
                    }
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        actionInProgress = false,
                        scanReview = if (scanApply) {
                            it.scanReview?.copy(applying = false, applyErrorKey = "apply_failed")
                        } else it.scanReview,
                        errorKey = if (scanApply && it.scanReview == null) "apply_failed" else it.errorKey,
                    )
                }
            } finally {
                // The scan gate is held through the apply; release it on every
                // terminal path (success, failure, cancellation).
                if (scanApply) scanInFlight = false
            }
        }
    }

    companion object {
        /** matchGoodsVerify is pure — the candidate lambdas are never used. */
        private val PURE_MATCHER = ScanMatcher({ _, _, _ -> emptyList() }, { _, _ -> emptyList() })

        private val EMPTY_CANDIDATES = OcrLabelParser.CandidateOptions(
            emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
        )

        private fun toTarget(item: VerifyBoxItem) = ScanMatcher.GoodsVerifyTarget(
            partId = item.partId,
            partNo = ScanPrimitives.normalize(item.partNo),
            qty = item.qty,
        )

        private fun OcrLabelParser.ParsedFields.toOcrInput() = ScanPrimitives.OcrInput(
            partNo = itemId ?: "",
            dateCode = dateCode ?: "",
            lotCode = lotCode ?: "",
            coo = coo ?: "",
            cow = cow ?: "",
            qty = qty?.toString() ?: "",
        )

        /** Per-boxId factory; the screen builds it from the app container. */
        fun provideFactory(container: AppContainer, boxId: String): ViewModelProvider.Factory {
            // Web useLabelScan.processCapture: QR/barcode values go through the supplier
            // QR templates first; when no template matches, fall back to OCR parsing.
            // No context supplier — the box aggregates parts across receiving orders.
            val labelScanParser = LabelScanParser { capture, targets ->
                val templates = withContext(Dispatchers.IO) {
                    container.scanRepository.supplierQrTemplates()
                }
                capture.barcodes.firstNotNullOfOrNull { barcode ->
                    QrParser.parseQrCapture(barcode.value, templates, targets, null)
                } ?: OcrLabelParser.parseAndIdentify(capture, targets)
            }
            return object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    if (modelClass.isAssignableFrom(GoodsVerifyBoxDetailViewModel::class.java)) {
                        return GoodsVerifyBoxDetailViewModel(
                            boxId,
                            container.goodsVerifyRepository,
                            container.sessionRepository,
                            labelScanParser = labelScanParser,
                        ) as T
                    }
                    throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
                }
            }
        }
    }
}
