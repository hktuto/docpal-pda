package com.docpal.warehousepda.ui.receiving

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.AppContainer
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.MismatchInfo
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.domain.model.User
import com.docpal.warehousepda.domain.scan.OcrLabelParser
import com.docpal.warehousepda.domain.scan.QrParser
import com.docpal.warehousepda.domain.scan.ScanMatcher
import com.docpal.warehousepda.domain.scan.ScanPrimitives
import com.docpal.warehousepda.ui.scan.LabelScanParser
import com.docpal.warehousepda.ui.scan.ScanMatchOption
import com.docpal.warehousepda.ui.scan.ScanMatchSource
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

/** Read/mutation slice of `ReceivingRepository` the detail screen needs. */
interface ReceivingDetailSource {
    suspend fun getOrderDetail(orderId: String): ReceivingOrderDetail
    suspend fun confirmArrived(orderId: String, actorId: String)
}

/** Mismatch mutation slice of `MismatchRepository` (domain). */
interface MismatchSource {
    suspend fun reportMismatch(
        itemId: String, actorId: String, reason: String,
        mismatchQty: Int?, wrongPartNo: String?, note: String,
    )

    suspend fun editMismatch(
        mismatchId: String, actorId: String, reason: String,
        mismatchQty: Int?, wrongPartNo: String?, note: String,
    )

    suspend fun confirmMismatch(mismatchId: String, actorId: String)
    suspend fun cancelMismatch(mismatchId: String, actorId: String)
}

/** Current-user slice of `SessionRepository`. */
interface SessionSource {
    fun currentUser(): User?
}

/** Picking mutation slice of `PickingRepository` (web picking.ts / ocrPicking.ts). */
interface PickingSource {
    suspend fun createBox(pickingOrderId: String, actorId: String)
    suspend fun addAllToBox(boxId: String, actorId: String)
    suspend fun addPackageToBox(packageId: String, boxId: String, actorId: String)
    suspend fun removePackageFromBox(packageId: String, actorId: String)
    suspend fun removeScannedPackage(packageId: String, actorId: String)
    suspend fun applyOcrPick(
        receivingOrderId: String, pickingItemId: String, qty: Int,
        dateCode: String?, lotCode: String?, coo: String?, cow: String?, actorId: String,
    )
}

// ScanMatchSource / LabelScanParser / ScanReviewUiState moved to ui/scan/ (shared
// with the picking flow); ReceivingDetailSource/MismatchSource/SessionSource/
// PickingSource still live here — moving them is a deferred cleanup
// (see the phase-3 plan's handoff notes).

data class ReceivingDetailUiState(
    val loading: Boolean = true,
    val detail: ReceivingOrderDetail? = null,
    val errorKey: String? = null,
    // LocalizedException.params, passed as %1$s format args when errorKey renders.
    val errorArgs: List<String> = emptyList(),
    val tab: Int = 0,
    val currentUserId: String? = null,
    val actionInProgress: Boolean = false,
    val scanPin: String? = null,
    val dialogOpen: Boolean = false,
    val scanReview: ScanReviewUiState? = null,
    val pendingAddAllBoxId: String? = null,
    val toastKey: String? = null,
)

/**
 * Loads the receiving order detail in `init` (the list VM instead relies on the
 * screen's OnResumeEffect; here the first query must be testable without Compose).
 * The screen still calls [reload] via OnResumeEffect — the initial ON_RESUME simply
 * cancels the in-flight init load and re-queries once, which [reload] absorbs.
 */
class ReceivingDetailViewModel(
    private val orderId: String,
    private val receivingSource: ReceivingDetailSource,
    private val mismatchSource: MismatchSource,
    private val sessionSource: SessionSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val pickingSource: PickingSource = NoopPickingSource,
    private val scanMatchSource: ScanMatchSource = ScanMatchSource { _, _, _ -> ScanMatcher.MatchResult.None },
    private val labelScanParser: LabelScanParser = LabelScanParser { capture, _ ->
        OcrLabelParser.parseAndIdentify(capture)
    },
) : ViewModel() {

    /** No-op defaults keep the pre-picking constructor call sites/tests valid. */
    private object NoopPickingSource : PickingSource {
        override suspend fun createBox(pickingOrderId: String, actorId: String) {}
        override suspend fun addAllToBox(boxId: String, actorId: String) {}
        override suspend fun addPackageToBox(packageId: String, boxId: String, actorId: String) {}
        override suspend fun removePackageFromBox(packageId: String, actorId: String) {}
        override suspend fun removeScannedPackage(packageId: String, actorId: String) {}
        override suspend fun applyOcrPick(
            receivingOrderId: String, pickingItemId: String, qty: Int,
            dateCode: String?, lotCode: String?, coo: String?, cow: String?, actorId: String,
        ) {}
    }

    private val _uiState = MutableStateFlow(ReceivingDetailUiState())
    val uiState: StateFlow<ReceivingDetailUiState> = _uiState.asStateFlow()

    private var loadJob: Job? = null

    /** Last matcher result — `applyScan` resolves dialog option ids against it. */
    private var lastMatchResult: ScanMatcher.MatchResult? = null

    init {
        reload()
    }

    fun setTab(tab: Int) = _uiState.update { it.copy(tab = tab) }

    /** Clears a surfaced error — called when the error's UI surface is dismissed/replaced. */
    fun clearError() = _uiState.update { it.copy(errorKey = null, errorArgs = emptyList()) }

    fun reload() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update { it.copy(loading = true) }
            try {
                val detail = withContext(io) { receivingSource.getOrderDetail(orderId) }
                val userId = withContext(io) { sessionSource.currentUser()?.id }
                _uiState.update {
                    it.copy(
                        loading = false, detail = detail, currentUserId = userId,
                        errorKey = null, errorArgs = emptyList(),
                    )
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
    }

    /** Four-eyes: only the reporter of a pending mismatch may edit it. */
    fun canEditMismatch(mismatch: MismatchInfo): Boolean =
        mismatch.status == "pending" && mismatch.reportedBy == _uiState.value.currentUserId

    /** Four-eyes: anyone except the reporter may confirm/cancel a pending mismatch. */
    fun canReviewMismatch(mismatch: MismatchInfo): Boolean =
        mismatch.status == "pending" && mismatch.reportedBy != _uiState.value.currentUserId

    fun confirmArrived() = runAction { actorId ->
        receivingSource.confirmArrived(orderId, actorId)
    }

    fun reportMismatch(itemId: String, reason: String, qty: Int?, wrongPart: String?, note: String) =
        runAction { actorId ->
            mismatchSource.reportMismatch(itemId, actorId, reason, qty, wrongPart, note)
        }

    fun editMismatch(mismatchId: String, reason: String, qty: Int?, wrongPart: String?, note: String) =
        runAction { actorId ->
            mismatchSource.editMismatch(mismatchId, actorId, reason, qty, wrongPart, note)
        }

    fun confirmMismatch(mismatchId: String) = runAction { actorId ->
        mismatchSource.confirmMismatch(mismatchId, actorId)
    }

    fun cancelMismatch(mismatchId: String) = runAction { actorId ->
        mismatchSource.cancelMismatch(mismatchId, actorId)
    }

    // --- Picking tab actions -------------------------------------------------

    /** Pins a picking item so the next scan only matches that item (web scan(pickingItemId)). */
    fun pinScan(pickingItemId: String?) = _uiState.update { it.copy(scanPin = pickingItemId) }

    /** The screen raises this while any dialog is open — it gates the hardware wedge. */
    fun setDialogOpen(open: Boolean) = _uiState.update { it.copy(dialogOpen = open) }

    fun clearToast() = _uiState.update { it.copy(toastKey = null) }

    fun createBox(pickingOrderId: String) = runAction { actorId ->
        pickingSource.createBox(pickingOrderId, actorId)
    }

    /** "Add all" is the only confirm-guarded picking action (web parity). */
    fun requestAddAll(boxId: String) = _uiState.update { it.copy(pendingAddAllBoxId = boxId) }

    fun dismissAddAll() = _uiState.update { it.copy(pendingAddAllBoxId = null) }

    fun confirmAddAll() {
        val boxId = _uiState.value.pendingAddAllBoxId ?: return
        _uiState.update { it.copy(pendingAddAllBoxId = null) }
        runAction { actorId -> pickingSource.addAllToBox(boxId, actorId) }
    }

    fun addPackageToBox(packageId: String, boxId: String) = runAction { actorId ->
        pickingSource.addPackageToBox(packageId, boxId, actorId)
    }

    fun removePackageFromBox(packageId: String) = runAction { actorId ->
        pickingSource.removePackageFromBox(packageId, actorId)
    }

    fun removeScannedPackage(packageId: String) = runAction { actorId ->
        pickingSource.removeScannedPackage(packageId, actorId)
    }

    // --- Scan review ----------------------------------------------------------

    /** Camera scan result: parse (QR template → OCR fallback) and open the review dialog. */
    fun openScanReview(text: String, barcodes: List<OcrLabelParser.OcrBarcode>, imagePath: String?) {
        if (_uiState.value.dialogOpen) return
        // A fresh dialog starts with no match state (defense in depth).
        lastMatchResult = null
        // Raise dialogOpen before parsing so a second wedge flush during the
        // parse window can't start a clobbering second parse.
        _uiState.update { it.copy(dialogOpen = true) }
        viewModelScope.launch {
            try {
                val targets = _uiState.value.detail?.let { partTargets(it) } ?: emptyList()
                val capture = OcrLabelParser.RawOcrCapture(text, barcodes)
                val result = withContext(io) { labelScanParser.parse(capture, targets) }
                _uiState.update {
                    it.copy(
                        scanReview = ScanReviewUiState(
                            manual = imagePath == null,
                            imagePath = imagePath,
                            fields = result.parsed.toOcrInput(),
                            options = result.options,
                        ),
                    )
                }
            } catch (e: CancellationException) {
                _uiState.update { it.copy(dialogOpen = false) }
                throw e
            } catch (e: LocalizedException) {
                _uiState.update {
                    it.copy(dialogOpen = false, errorKey = e.code, errorArgs = e.params.values.toList())
                }
            } catch (e: Exception) {
                // Parsing does Room I/O (templates/supplier) — surface failures.
                _uiState.update { it.copy(dialogOpen = false, errorKey = "scan_parse_failed") }
            }
        }
    }

    /** Hardware wedge flush — same handling as a camera scan without an image. */
    fun onHardwareScan(text: String) {
        if (_uiState.value.dialogOpen) return
        openScanReview(text, listOf(OcrLabelParser.OcrBarcode(text, "4")), null)
    }

    fun openManualEntry() {
        if (_uiState.value.dialogOpen) return
        // A fresh dialog starts with no match state (defense in depth).
        lastMatchResult = null
        _uiState.update {
            it.copy(
                dialogOpen = true,
                scanReview = ScanReviewUiState(
                    manual = true,
                    imagePath = null,
                    fields = ScanPrimitives.OcrInput("", "", "", "", "", ""),
                    options = EMPTY_CANDIDATES,
                ),
            )
        }
    }

    fun closeScanReview() {
        lastMatchResult = null
        _uiState.update {
            it.copy(scanReview = null, dialogOpen = false, scanPin = null)
        }
    }

    fun updateScanFields(fields: ScanPrimitives.OcrInput) = _uiState.update {
        it.copy(scanReview = it.scanReview?.copy(fields = fields))
    }

    fun findMatch(fields: ScanPrimitives.OcrInput? = null) {
        val review = _uiState.value.scanReview ?: return
        if (review.matching) return
        val f = fields ?: review.fields
        viewModelScope.launch {
            _uiState.update { it.copy(scanReview = review.copy(matching = true, applyErrorKey = null)) }
            try {
                val result = withContext(io) {
                    scanMatchSource.matchReceiving(
                        ScanMatcher.ReceivingContext(orderId, _uiState.value.scanPin),
                        f,
                        sessionSource.currentUser()?.id,
                    )
                }
                applyMatchResult(result)
            } catch (e: CancellationException) {
                _uiState.update { it.copy(scanReview = it.scanReview?.copy(matching = false)) }
                throw e
            } catch (e: Exception) {
                // Don't strand the dialog with matching=true if the seam throws.
                applyMatchResult(ScanMatcher.MatchResult.Error("unknown_match_failed"))
            }
        }
    }

    /** Maps a matcher result onto the generalized review-dialog options/message state. */
    private fun applyMatchResult(result: ScanMatcher.MatchResult) {
        // A closeScanReview() racing an in-flight findMatch leaves scanReview null;
        // don't let lastMatchResult outlive its dialog.
        if (_uiState.value.scanReview == null) return
        lastMatchResult = result
        val options: List<ScanMatchOption>
        val messageRes: Int
        val errorKey: String?
        when (result) {
            is ScanMatcher.MatchResult.Single -> {
                options = listOf(scanMatchOption(result.record))
                messageRes = R.string.scan_review_match_single
                errorKey = null
            }
            is ScanMatcher.MatchResult.Multiple -> {
                options = result.records.map(::scanMatchOption)
                messageRes = R.string.scan_review_match_multiple
                errorKey = null
            }
            ScanMatcher.MatchResult.None -> {
                options = emptyList()
                messageRes = R.string.scan_review_match_none
                errorKey = null
            }
            is ScanMatcher.MatchResult.Error -> {
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

    /** Dialog option for a matched record; label is the web formatRecord string. */
    private fun scanMatchOption(record: ScanMatcher.MatchedRecord): ScanMatchOption {
        val p = record.picking
        return ScanMatchOption(
            id = "${p.pickingItemId}|${record.receiving.receivingInvoiceItemId}",
            label = "${p.pickingOrderRefNo} (${p.remainingQty} / ${p.requiredQty})",
        )
    }

    /** Resolves a dialog option id back to the matcher's record (id round-trips). */
    private fun matchedRecordFor(optionId: String): ScanMatcher.MatchedRecord? {
        val records = when (val result = lastMatchResult) {
            is ScanMatcher.MatchResult.Single -> listOf(result.record)
            is ScanMatcher.MatchResult.Multiple -> result.records
            else -> emptyList()
        }
        return records.firstOrNull { scanMatchOption(it).id == optionId }
    }

    /** Applies a chosen match via applyOcrPick; success closes the dialog + toasts + reloads. */
    fun applyScan(optionId: String, fields: ScanPrimitives.OcrInput? = null) {
        val review = _uiState.value.scanReview ?: return
        if (review.applying) return
        val match = matchedRecordFor(optionId) ?: return
        val f = fields ?: review.fields
        viewModelScope.launch {
            _uiState.update { it.copy(scanReview = review.copy(applying = true, applyErrorKey = null)) }
            try {
                withContext(io) {
                    val actorId = sessionSource.currentUser()?.id
                        ?: throw LocalizedException("operator_not_signed_in")
                    val p = ScanPrimitives.parseManual(f)
                    pickingSource.applyOcrPick(
                        orderId, match.picking.pickingItemId, p.qty,
                        p.dateCode, p.lotCode, p.coo, p.cow, actorId,
                    )
                }
                lastMatchResult = null
                _uiState.update {
                    it.copy(
                        scanReview = null, dialogOpen = false, scanPin = null,
                        toastKey = "common_scan_success",
                    )
                }
                reload()
            } catch (e: CancellationException) {
                _uiState.update { it.copy(scanReview = it.scanReview?.copy(applying = false)) }
                throw e
            } catch (e: LocalizedException) {
                _uiState.update {
                    it.copy(scanReview = it.scanReview?.copy(applying = false, applyErrorKey = e.code))
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(scanReview = it.scanReview?.copy(applying = false, applyErrorKey = "apply_failed"))
                }
            }
        }
    }

    private fun runAction(block: suspend (actorId: String) -> Unit) {
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
                _uiState.update { it.copy(actionInProgress = false) }
                reload()
            } catch (e: CancellationException) {
                _uiState.update { it.copy(actionInProgress = false) }
                throw e
            } catch (e: LocalizedException) {
                _uiState.update {
                    it.copy(
                        actionInProgress = false,
                        errorKey = e.code,
                        errorArgs = e.params.values.toList(),
                    )
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(actionInProgress = false) }
            }
        }
    }

    companion object {
        private val EMPTY_CANDIDATES = OcrLabelParser.CandidateOptions(
            emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
        )

        /** Part numbers of the receiving order — the parse/match gate (web context.targets). */
        private fun partTargets(detail: ReceivingOrderDetail): List<String> =
            detail.invoices.flatMap { invoice -> invoice.items.map { it.partNo } }.distinct()

        private fun OcrLabelParser.ParsedFields.toOcrInput() = ScanPrimitives.OcrInput(
            partNo = itemId ?: "",
            dateCode = dateCode ?: "",
            lotCode = lotCode ?: "",
            coo = coo ?: "",
            cow = cow ?: "",
            qty = qty?.toString() ?: "",
        )

        /** Per-orderId factory; screens build it from the app container. */
        fun provideFactory(container: AppContainer, orderId: String): ViewModelProvider.Factory {
            val repo = container.pickingRepository
            val pickingSource = object : PickingSource {
                override suspend fun createBox(pickingOrderId: String, actorId: String) {
                    repo.createShippingBoxForPickingOrder(pickingOrderId, actorId)
                }

                override suspend fun addAllToBox(boxId: String, actorId: String) {
                    repo.addAllUnboxedPackagesToBox(boxId, actorId)
                }

                override suspend fun addPackageToBox(packageId: String, boxId: String, actorId: String) {
                    repo.addPackageToBox(packageId, boxId, actorId)
                }

                override suspend fun removePackageFromBox(packageId: String, actorId: String) =
                    repo.removePackageFromBox(packageId, actorId)

                override suspend fun removeScannedPackage(packageId: String, actorId: String) =
                    repo.removeScannedPackage(packageId, actorId)

                override suspend fun applyOcrPick(
                    receivingOrderId: String, pickingItemId: String, qty: Int,
                    dateCode: String?, lotCode: String?, coo: String?, cow: String?, actorId: String,
                ) = repo.applyOcrPick(
                    receivingOrderId, pickingItemId, qty, dateCode, lotCode, coo, cow, actorId,
                )
            }
            val scanMatchSource = ScanMatchSource { ctx, parsed, actorId ->
                container.scanMatcher.matchReceiving(ctx, parsed, actorId)
            }
            // Web useLabelScan.processCapture: QR/barcode values go through the supplier
            // QR templates first; when no template matches, fall back to OCR parsing.
            val labelScanParser = LabelScanParser { capture, targets ->
                val templates = withContext(Dispatchers.IO) {
                    container.scanRepository.supplierQrTemplates()
                }
                val supplierCode = withContext(Dispatchers.IO) {
                    container.receivingRepository.supplierCodeOfOrder(orderId)
                }
                capture.barcodes.firstNotNullOfOrNull { barcode ->
                    QrParser.parseQrCapture(barcode.value, templates, targets, supplierCode)
                } ?: OcrLabelParser.parseAndIdentify(capture, targets)
            }
            return object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    if (modelClass.isAssignableFrom(ReceivingDetailViewModel::class.java)) {
                        return ReceivingDetailViewModel(
                            orderId,
                            container.receivingRepository,
                            container.mismatchRepository,
                            container.sessionRepository,
                            pickingSource = pickingSource,
                            scanMatchSource = scanMatchSource,
                            labelScanParser = labelScanParser,
                        ) as T
                    }
                    throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
                }
            }
        }
    }
}
