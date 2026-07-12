package com.docpal.warehousepda.ui.putaway

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.AppContainer
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PutAwayDetail
import com.docpal.warehousepda.domain.model.PutAwayLotDetail
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

/** Read/mutation slice of `PutAwayRepository` the put-away detail screen needs. */
interface PutAwayDetailSource {
    suspend fun getPutAwayDetail(orderId: String): PutAwayDetail?

    /** Shelf-box creation — `PutAwayRepository.createShelfBox`. */
    suspend fun createBox(orderId: String, shelfCode: String, actorId: String)
    suspend fun assignScanToBox(scanId: String, boxId: String, actorId: String)

    /** Add-all — `PutAwayRepository.addAllUnboxedToBox`. */
    suspend fun addAllToBox(boxId: String, actorId: String)
    suspend fun removeScanFromBox(scanId: String, actorId: String)
    suspend fun removeScannedPiece(scanId: String)

    /** Box close — `PutAwayRepository.closeShelfBox`. */
    suspend fun closeBox(boxId: String, actorId: String)

    /** Box cancel — `PutAwayRepository.cancelShelfBox`. */
    suspend fun cancelBox(boxId: String, actorId: String)

    /** Scan-to-put-away (Task 10) — `PutAwayRepository.recordPutAwayScan`. Returns the new scan id. */
    suspend fun recordScan(
        receivingInvoiceItemId: String, qty: Int,
        dateCode: String?, lotCode: String?, coo: String?, cow: String?,
    ): String
}

data class PutAwayDetailUiState(
    val loading: Boolean = true,
    val detail: PutAwayDetail? = null,
    val errorKey: String? = null,
    // LocalizedException.params, passed as %1$s format args when errorKey renders.
    val errorArgs: List<String> = emptyList(),
    val actionInProgress: Boolean = false,
    val pendingAddAllBoxId: String? = null,
    val showShelfDialog: Boolean = false,
    val toastKey: String? = null,
    // LocalizedException.params when toastKey is an error code (auto-apply error toast).
    val toastArgs: List<String> = emptyList(),
    // Scan-to-put-away (Task 10): pinned lot, review dialog.
    val scanPin: ScanMatcher.PinnedPutAwayItem? = null,
    val scanReview: ScanReviewUiState? = null,
    val dialogOpen: Boolean = false,
) {
    /** Unboxed scans of the order — gates the "Add all" buttons (web unboxedCountForOrder). */
    val unboxedScanCount: Int
        get() = detail?.scans?.count { it.shelfBoxId == null } ?: 0
}

/**
 * Loads the put-away detail in `init` (the first query must be testable without Compose).
 * The screen still calls [reload] via OnResumeEffect — the initial ON_RESUME simply cancels
 * the in-flight init load and re-queries once. Mirrors PickingDetailViewModel.
 */
class PutAwayDetailViewModel(
    private val orderId: String,
    private val putAwaySource: PutAwayDetailSource,
    private val sessionSource: SessionSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val labelScanParser: LabelScanParser = LabelScanParser { capture, targets ->
        OcrLabelParser.parseAndIdentify(capture, targets)
    },
) : ViewModel() {

    private val _uiState = MutableStateFlow(PutAwayDetailUiState())
    val uiState: StateFlow<PutAwayDetailUiState> = _uiState.asStateFlow()

    private var loadJob: Job? = null

    /** Last matchPutAway result — `applyScan` resolves dialog option ids against it. */
    private var lastMatch: ScanMatcher.PutAwayMatchResult? = null

    /**
     * Transient guard (NOT UiState): rejects a second scan while a parse/auto-apply is
     * in flight, so two scans can't interleave (a scan B success wiping scan A's error
     * dialog). Held through parse + auto-apply; released the moment dialogOpen takes
     * over as the gate. Cleared on every terminal path by construction.
     */
    private var scanInFlight = false

    init {
        reload()
    }

    /** Clears a surfaced error — called when the error's UI surface is dismissed/replaced. */
    fun clearError() = _uiState.update { it.copy(errorKey = null, errorArgs = emptyList()) }

    fun clearToast() = _uiState.update { it.copy(toastKey = null, toastArgs = emptyList()) }

    fun reload(): Job {
        loadJob?.cancel()
        val job = viewModelScope.launch {
            _uiState.update { it.copy(loading = true) }
            try {
                val detail = withContext(io) { putAwaySource.getPutAwayDetail(orderId) }
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

    // --- Select-shelf dialog (new box) -----------------------------------------

    fun openShelfDialog() = _uiState.update { it.copy(showShelfDialog = true) }

    fun dismissShelfDialog() = _uiState.update { it.copy(showShelfDialog = false) }

    /** Confirming the shelf dialog creates the box; the box appears after reload (no toast). */
    fun createBox(shelfCode: String) {
        _uiState.update { it.copy(showShelfDialog = false) }
        runAction { actorId -> putAwaySource.createBox(orderId, shelfCode, actorId) }
    }

    // --- Box mutations -----------------------------------------------------------

    /** "Add all" is the only confirm-guarded put-away action (web parity). */
    fun requestAddAll(boxId: String) = _uiState.update { it.copy(pendingAddAllBoxId = boxId) }

    fun dismissAddAll() = _uiState.update { it.copy(pendingAddAllBoxId = null) }

    fun confirmAddAll() {
        val boxId = _uiState.value.pendingAddAllBoxId ?: return
        _uiState.update { it.copy(pendingAddAllBoxId = null) }
        runAction { actorId -> putAwaySource.addAllToBox(boxId, actorId) }
    }

    fun closeBox(boxId: String) = runAction { actorId -> putAwaySource.closeBox(boxId, actorId) }

    fun cancelBox(boxId: String) = runAction { actorId -> putAwaySource.cancelBox(boxId, actorId) }

    // --- Scan mutations (recorded by Task 10's scan flow; boxed here) --------------

    fun assignScanToBox(scanId: String, boxId: String) = runAction { actorId ->
        putAwaySource.assignScanToBox(scanId, boxId, actorId)
    }

    fun removeScanFromBox(scanId: String) = runAction { actorId ->
        putAwaySource.removeScanFromBox(scanId, actorId)
    }

    /** Web removeScannedPiece takes no actor — the runAction actor is fetched but unused. */
    fun removeScan(scanId: String) = runAction { putAwaySource.removeScannedPiece(scanId) }

    // --- Scan-to-put-away ---------------------------------------------------------

    /** Pins a lot so the next scan only matches it (web openScan's scanLot). */
    fun pinLot(lot: PutAwayLotDetail) = _uiState.update { it.copy(scanPin = toPin(lot)) }

    /** Camera scan result: parse (QR template → OCR fallback), then run the pinned flow. */
    fun onCameraScan(result: CameraScanResult) {
        if (_uiState.value.dialogOpen || scanInFlight) return
        // Put-away scans are always pinned (per-lot buttons; the web page has no wedge).
        val pin = _uiState.value.scanPin ?: return
        scanInFlight = true
        viewModelScope.launch {
            try {
                // Web openScan passes targets: [lot.partNo] (raw; the parsers normalize).
                val lot = _uiState.value.detail?.lots
                    ?.firstOrNull { it.receivingInvoiceItemId == pin.receivingInvoiceItemId }
                val targets = listOfNotNull(lot?.partNo ?: pin.partNo.ifEmpty { null })
                val capture = OcrLabelParser.RawOcrCapture(
                    result.rawText,
                    result.barcodes.map { OcrLabelParser.OcrBarcode(it.value, it.format) },
                )
                val parsed = withContext(io) { labelScanParser.parse(capture, targets) }
                val fields = parsed.parsed.toOcrInput()
                // dispatchMatch either opens the review dialog (openScanReviewOnError
                // releases the gate — dialogOpen takes over) or starts applyScanned
                // (runAction's scanApply finally releases it when the apply finishes).
                dispatchMatch(pin, fields, result.imagePath)
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
                // Parsing does Room I/O (templates/supplier) — surface failures.
                _uiState.update { it.copy(errorKey = "scan_parse_failed") }
            }
        }
    }

    /**
     * Pinned flow (web useLabelScan): a single match auto-applies without a dialog
     * (put-away has no confirmSingleMatch); a match error opens the review dialog.
     */
    private fun dispatchMatch(
        pin: ScanMatcher.PinnedPutAwayItem,
        fields: ScanPrimitives.OcrInput,
        imagePath: String?,
    ) {
        when (val result = PURE_MATCHER.matchPutAway(pin, fields, sessionSource.currentUser()?.id)) {
            is ScanMatcher.PutAwayMatchResult.Single -> applyScanned(pin, fields, result.qty)
            is ScanMatcher.PutAwayMatchResult.Error -> openScanReviewOnError(fields, imagePath, result.key)
        }
    }

    private fun openScanReviewOnError(
        fields: ScanPrimitives.OcrInput,
        imagePath: String?,
        errorKey: String,
    ) {
        lastMatch = null
        // Raise dialogOpen at entry (Phase 1 race fix: no second parse can start
        // while the dialog is being built), then release the in-flight gate —
        // dialogOpen is the gate from here on.
        _uiState.update {
            it.copy(
                dialogOpen = true,
                scanReview = ScanReviewUiState(
                    manual = imagePath == null,
                    imagePath = imagePath,
                    fields = fields,
                    options = EMPTY_CANDIDATES,
                    matchMessageRes = R.string.scan_review_error,
                    matchErrorKey = errorKey,
                ),
            )
        }
        scanInFlight = false
    }

    fun updateScanFields(fields: ScanPrimitives.OcrInput) = _uiState.update {
        it.copy(scanReview = it.scanReview?.copy(fields = fields))
    }

    /** Find match re-runs matchPutAway against the same pin with the edited fields. */
    fun findMatch() {
        val review = _uiState.value.scanReview ?: return
        if (review.matching) return
        val pin = _uiState.value.scanPin ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(scanReview = review.copy(matching = true, applyErrorKey = null)) }
            // matchPutAway is pure — no io hop; the launch keeps the matching state observable.
            val result = PURE_MATCHER.matchPutAway(pin, review.fields, sessionSource.currentUser()?.id)
            applyMatchResult(result)
        }
    }

    /** Maps a matchPutAway result onto the review dialog's single-option/error state. */
    private fun applyMatchResult(result: ScanMatcher.PutAwayMatchResult) {
        // A closeScanReview() racing an in-flight findMatch leaves scanReview null;
        // don't let lastMatch outlive its dialog.
        if (_uiState.value.scanReview == null) return
        lastMatch = result
        val options: List<ScanMatchOption>
        val messageRes: Int
        val errorKey: String?
        when (result) {
            is ScanMatcher.PutAwayMatchResult.Single -> {
                options = listOf(
                    ScanMatchOption(
                        id = result.item.receivingInvoiceItemId,
                        label = "${result.item.partNo} (${result.qty})",
                    )
                )
                messageRes = R.string.scan_review_match_single
                errorKey = null
            }
            is ScanMatcher.PutAwayMatchResult.Error -> {
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

    /** Applies the dialog's single match — same dispatch as the auto-apply path. */
    fun applyScan(optionId: String) {
        val review = _uiState.value.scanReview ?: return
        if (review.applying) return
        val single = (lastMatch as? ScanMatcher.PutAwayMatchResult.Single) ?: return
        if (single.item.receivingInvoiceItemId != optionId) return
        lastMatch = null
        _uiState.update { it.copy(scanReview = review.copy(applying = true, applyErrorKey = null)) }
        applyScanned(single.item, review.fields, single.qty)
    }

    /** Retake keeps the pin: the re-scan matches the same lot (web onRetake). */
    fun retakeScan() {
        lastMatch = null
        _uiState.update { it.copy(scanReview = null, dialogOpen = false) }
    }

    fun closeScanReview() {
        lastMatch = null
        _uiState.update {
            it.copy(scanReview = null, dialogOpen = false, scanPin = null)
        }
    }

    /**
     * recordPutAwayScan dispatch (web useScanMatchers apply), wrapped in the shared
     * action runner. [qty] is the matchPutAway-validated scan quantity — do not
     * re-run parseManual for it.
     */
    private fun applyScanned(pin: ScanMatcher.PinnedPutAwayItem, fields: ScanPrimitives.OcrInput, qty: Int) {
        // Mirror runAction's serialization guard: when another action holds it,
        // runAction would no-op without a coroutine — release the scan gate here
        // so it can't strand.
        if (_uiState.value.actionInProgress) {
            scanInFlight = false
            return
        }
        runAction(toastKeyAfterReload = "common_scan_success", scanApply = true) {
            val f = ancillaryFields(fields)
            putAwaySource.recordScan(
                pin.receivingInvoiceItemId, qty, f.dateCode, f.lotCode, f.coo, f.cow,
            )
        }
    }

    private fun runAction(
        toastKeyAfterReload: String? = null,
        scanApply: Boolean = false,
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
                        // A successful scan apply closes the dialog + clears the pin.
                        scanPin = if (scanApply) null else it.scanPin,
                        scanReview = if (scanApply) null else it.scanReview,
                        dialogOpen = if (scanApply) false else it.dialogOpen,
                    )
                }
                reload().join()
                if (toastKeyAfterReload != null) {
                    _uiState.update { it.copy(toastKey = toastKeyAfterReload, toastArgs = emptyList()) }
                }
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
                    when {
                        !scanApply -> it.copy(
                            actionInProgress = false,
                            errorKey = e.code,
                            errorArgs = e.params.values.toList(),
                        )
                        // Dialog apply: inline error, the dialog stays open.
                        it.scanReview != null -> it.copy(
                            actionInProgress = false,
                            scanReview = it.scanReview?.copy(applying = false, applyErrorKey = e.code),
                        )
                        // Auto-apply: no dialog surface — toast the error (web showToast).
                        else -> it.copy(
                            actionInProgress = false,
                            toastKey = e.code,
                            toastArgs = e.params.values.toList(),
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
                        toastKey = if (scanApply && it.scanReview == null) "apply_failed" else it.toastKey,
                    )
                }
            } finally {
                // The scan gate is held through the auto-apply; release it on every
                // terminal path (success, failure, cancellation).
                if (scanApply) scanInFlight = false
            }
        }
    }

    companion object {
        /** matchPutAway is pure — the candidate lambdas are never used. */
        private val PURE_MATCHER = ScanMatcher({ _, _, _ -> emptyList() }, { _, _ -> emptyList() })

        private val EMPTY_CANDIDATES = OcrLabelParser.CandidateOptions(
            emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
        )

        private fun toPin(lot: PutAwayLotDetail) = ScanMatcher.PinnedPutAwayItem(
            receivingInvoiceItemId = lot.receivingInvoiceItemId,
            partNo = ScanPrimitives.normalize(lot.partNo ?: ""),
            availableQty = lot.availableQty,
        )

        /** Ancillary-field normalization — parseManual minus the qty gate (qty comes from the match). */
        private fun ancillaryFields(f: ScanPrimitives.OcrInput) = AncillaryFields(
            dateCode = f.dateCode.ifEmpty { null }?.let(ScanPrimitives::normalizeCode),
            lotCode = f.lotCode.ifEmpty { null }?.let(ScanPrimitives::normalizeCode),
            coo = f.coo.ifEmpty { null }?.let(ScanPrimitives::normalize),
            cow = f.cow.ifEmpty { null }?.let(ScanPrimitives::normalize),
        )

        private data class AncillaryFields(
            val dateCode: String?, val lotCode: String?, val coo: String?, val cow: String?,
        )

        private fun OcrLabelParser.ParsedFields.toOcrInput() = ScanPrimitives.OcrInput(
            partNo = itemId ?: "",
            dateCode = dateCode ?: "",
            lotCode = lotCode ?: "",
            coo = coo ?: "",
            cow = cow ?: "",
            qty = qty?.toString() ?: "",
        )

        /** Per-orderId factory; the screen builds it from the app container. */
        fun provideFactory(container: AppContainer, orderId: String): ViewModelProvider.Factory {
            // Web useLabelScan.processCapture: QR/barcode values go through the supplier
            // QR templates first; when no template matches, fall back to OCR parsing.
            val labelScanParser = LabelScanParser { capture, targets ->
                val templates = withContext(Dispatchers.IO) {
                    container.scanRepository.supplierQrTemplates()
                }
                val supplierCode = withContext(Dispatchers.IO) {
                    container.putAwayRepository.getPutAwayDetail(orderId)?.header?.supplierCode
                }
                capture.barcodes.firstNotNullOfOrNull { barcode ->
                    QrParser.parseQrCapture(barcode.value, templates, targets, supplierCode)
                } ?: OcrLabelParser.parseAndIdentify(capture, targets)
            }
            return object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    if (modelClass.isAssignableFrom(PutAwayDetailViewModel::class.java)) {
                        return PutAwayDetailViewModel(
                            orderId,
                            container.putAwayRepository,
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
