package com.docpal.warehousepda.ui.picking

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.AppContainer
import com.docpal.warehousepda.R
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PickingAllocationDetail
import com.docpal.warehousepda.domain.model.PickingItemDetail
import com.docpal.warehousepda.domain.model.PickingItemLogEntry
import com.docpal.warehousepda.domain.model.PickingOrderDetail
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

/** Read/mutation slice of `PickingRepository` the picking detail screen needs. */
interface PickingDetailSource {
    suspend fun getPickingOrderDetail(orderId: String): PickingOrderDetail?
    suspend fun pickingItemLogs(itemIds: List<String>): Map<String, List<PickingItemLogEntry>>
    suspend fun createBox(pickingOrderId: String, actorId: String)
    suspend fun cancelBox(boxId: String, actorId: String)
    suspend fun addAllToBox(boxId: String, actorId: String)
    suspend fun addPackageToBox(packageId: String, shippingBoxId: String, actorId: String)
    suspend fun removePackageFromBox(packageId: String, actorId: String)
    suspend fun finishPicking(orderId: String, actorId: String)

    /** Scan-to-pick (Task 10) — `PickingRepository.scanAllocationToPackage`. */
    suspend fun scanAllocation(allocationId: String, qty: Int, actorId: String): String

    /** Scan-to-pick against a receiving-order-backed allocation — `PickingRepository.applyOcrPick`. */
    suspend fun applyOcrPick(
        receivingOrderId: String, pickingItemId: String, qty: Int,
        dateCode: String?, lotCode: String?, coo: String?, cow: String?, actorId: String,
    )
}

data class PickingDetailUiState(
    val loading: Boolean = true,
    val detail: PickingOrderDetail? = null,
    val logs: Map<String, List<PickingItemLogEntry>> = emptyMap(),
    val errorKey: String? = null,
    // LocalizedException.params, passed as %1$s format args when errorKey renders.
    val errorArgs: List<String> = emptyList(),
    val currentUserId: String? = null,
    val actionInProgress: Boolean = false,
    val pendingAddAllBoxId: String? = null,
    val toastKey: String? = null,
    // LocalizedException.params when toastKey is an error code (auto-apply error toast).
    val toastArgs: List<String> = emptyList(),
    // Scan-to-pick (Task 10): pinned allocation, review dialog, wedge gate, pending parse.
    val scanPin: ScanMatcher.PinnedAllocation? = null,
    val scanReview: ScanReviewUiState? = null,
    val dialogOpen: Boolean = false,
    val pendingParse: ScanPrimitives.OcrInput? = null,
    val pendingImagePath: String? = null,
) {
    /**
     * Web allItemsFullyBoxed + the actionable gate: finish is offered while the order is
     * not finished/issue and every item is fully boxed. Like the web (Array.every on an
     * empty list is true), an order with zero items qualifies — finishPickingOrder then
     * rejects it with no_items_to_pick.
     */
    val canFinish: Boolean
        get() = detail?.let {
            it.status != "finished" && it.status != "issue" &&
                it.items.all { item -> item.pickedQty >= item.qty }
        } ?: false
}

/**
 * Loads the picking order detail + per-item logs in `init` (the first query must be
 * testable without Compose). The screen still calls [reload] via OnResumeEffect — the
 * initial ON_RESUME simply cancels the in-flight init load and re-queries once, which
 * [reload] absorbs. Mirrors ReceivingDetailViewModel.
 */
class PickingDetailViewModel(
    private val orderId: String,
    private val pickingSource: PickingDetailSource,
    private val sessionSource: SessionSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val labelScanParser: LabelScanParser = LabelScanParser { capture, targets ->
        OcrLabelParser.parseAndIdentify(capture, targets)
    },
) : ViewModel() {

    private val _uiState = MutableStateFlow(PickingDetailUiState())
    val uiState: StateFlow<PickingDetailUiState> = _uiState.asStateFlow()

    private var loadJob: Job? = null

    /** Last matchPicking result — `applyScan` resolves dialog option ids against it. */
    private var lastMatch: ScanMatcher.PickingMatchResult? = null

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
                val detail = withContext(io) { pickingSource.getPickingOrderDetail(orderId) }
                val logs = withContext(io) {
                    detail?.let { pickingSource.pickingItemLogs(it.items.map { item -> item.id }) }
                        ?: emptyMap()
                }
                val userId = withContext(io) { sessionSource.currentUser()?.id }
                _uiState.update {
                    it.copy(
                        loading = false, detail = detail, logs = logs, currentUserId = userId,
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
        loadJob = job
        return job
    }

    fun createBox() = runAction { actorId -> pickingSource.createBox(orderId, actorId) }

    fun cancelBox(boxId: String) = runAction { actorId -> pickingSource.cancelBox(boxId, actorId) }

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

    /**
     * Web finish(): reload, then toast when a measuring task exists afterwards
     * (finishPickingOrder creates it server-side).
     */
    fun finishPicking() = runAction(toastKeyAfterReload = "measuring_task_created") { actorId ->
        pickingSource.finishPicking(orderId, actorId)
    }

    // --- Scan-to-pick ---------------------------------------------------------

    /** Pins an allocation so the next scan only matches it (web openScan's scanAllocation). */
    fun pinAllocation(allocation: PickingAllocationDetail, item: PickingItemDetail) =
        _uiState.update { it.copy(scanPin = toPin(allocation, item)) }

    /** Camera scan result: parse (QR template → OCR fallback), then run the pinned flow. */
    fun onCameraScan(result: CameraScanResult) {
        if (_uiState.value.dialogOpen) return
        handleScan(
            result.rawText,
            result.barcodes.map { OcrLabelParser.OcrBarcode(it.value, it.format) },
            result.imagePath,
        )
    }

    /** Hardware wedge flush — same handling as a camera scan without an image. */
    fun onHardwareScan(text: String) {
        if (_uiState.value.dialogOpen) return
        handleScan(text, listOf(OcrLabelParser.OcrBarcode(text, "4")), null)
    }

    private fun handleScan(text: String, barcodes: List<OcrLabelParser.OcrBarcode>, imagePath: String?) {
        viewModelScope.launch {
            try {
                val detail = _uiState.value.detail
                val targets = detail?.items?.mapNotNull { it.partNo }?.distinct().orEmpty()
                val capture = OcrLabelParser.RawOcrCapture(text, barcodes)
                val result = withContext(io) { labelScanParser.parse(capture, targets) }
                val fields = result.parsed.toOcrInput()
                _uiState.update { it.copy(pendingParse = fields, pendingImagePath = imagePath) }

                // Wedge without a pin: locate the allocation by part number
                // (web findMatchingAllocation).
                var pin = _uiState.value.scanPin
                if (pin == null) {
                    pin = findMatchingAllocation(fields, detail)
                    if (pin == null) {
                        _uiState.update {
                            it.copy(
                                toastKey = "picking_detail_no_matching_allocation",
                                toastArgs = emptyList(),
                            )
                        }
                        return@launch
                    }
                    _uiState.update { it.copy(scanPin = pin) }
                }
                dispatchMatch(pin, fields, imagePath)
            } catch (e: CancellationException) {
                throw e
            } catch (e: LocalizedException) {
                _uiState.update {
                    it.copy(errorKey = e.code, errorArgs = e.params.values.toList())
                }
            } catch (e: Exception) {
                // Parsing does Room I/O (templates/supplier) — surface failures.
                _uiState.update { it.copy(errorKey = "scan_parse_failed") }
            }
        }
    }

    /**
     * Pinned flow (web useLabelScan): a single match auto-applies without a dialog
     * (picking has no confirmSingleMatch); a match error opens the review dialog.
     */
    private fun dispatchMatch(
        pin: ScanMatcher.PinnedAllocation,
        fields: ScanPrimitives.OcrInput,
        imagePath: String?,
    ) {
        when (val result = PURE_MATCHER.matchPicking(pin, fields, sessionSource.currentUser()?.id)) {
            is ScanMatcher.PickingMatchResult.Single -> applyPicked(pin, fields, result.qty)
            is ScanMatcher.PickingMatchResult.Error -> openScanReviewOnError(fields, imagePath, result.key)
        }
    }

    private fun openScanReviewOnError(
        fields: ScanPrimitives.OcrInput,
        imagePath: String?,
        errorKey: String,
    ) {
        lastMatch = null
        // Raise dialogOpen at entry (Phase 1 race fix: no second parse can start
        // while the dialog is being built).
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
    }

    fun updateScanFields(fields: ScanPrimitives.OcrInput) = _uiState.update {
        it.copy(scanReview = it.scanReview?.copy(fields = fields))
    }

    /** Find match re-runs matchPicking against the same pin with the edited fields. */
    fun findMatch() {
        val review = _uiState.value.scanReview ?: return
        if (review.matching) return
        val pin = _uiState.value.scanPin ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(scanReview = review.copy(matching = true, applyErrorKey = null)) }
            // matchPicking is pure — no io hop; the launch keeps the matching state observable.
            val result = PURE_MATCHER.matchPicking(pin, review.fields, sessionSource.currentUser()?.id)
            applyMatchResult(result)
        }
    }

    /** Maps a matchPicking result onto the review dialog's single-option/error state. */
    private fun applyMatchResult(result: ScanMatcher.PickingMatchResult) {
        // A closeScanReview() racing an in-flight findMatch leaves scanReview null;
        // don't let lastMatch outlive its dialog.
        if (_uiState.value.scanReview == null) return
        lastMatch = result
        val options: List<ScanMatchOption>
        val messageRes: Int
        val errorKey: String?
        when (result) {
            is ScanMatcher.PickingMatchResult.Single -> {
                options = listOf(
                    ScanMatchOption(
                        id = optionId(result.allocation),
                        label = "${result.allocation.partNo} (${result.qty})",
                    )
                )
                messageRes = R.string.scan_review_match_single
                errorKey = null
            }
            is ScanMatcher.PickingMatchResult.Error -> {
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

    /** Dialog option id round-trips to the pinned allocation. */
    private fun optionId(pin: ScanMatcher.PinnedAllocation): String =
        pin.allocationId ?: pin.pickingItemId

    /** Applies the dialog's single match — same dispatch as the auto-apply path. */
    fun applyScan(optionId: String) {
        val review = _uiState.value.scanReview ?: return
        if (review.applying) return
        val single = (lastMatch as? ScanMatcher.PickingMatchResult.Single) ?: return
        if (optionId(single.allocation) != optionId) return
        lastMatch = null
        _uiState.update { it.copy(scanReview = review.copy(applying = true, applyErrorKey = null)) }
        applyPicked(single.allocation, review.fields, single.qty)
    }

    /** Retake keeps the pin: the re-scan matches the same allocation (web onRetake). */
    fun retakeScan() {
        lastMatch = null
        _uiState.update { it.copy(scanReview = null, dialogOpen = false) }
    }

    fun closeScanReview() {
        lastMatch = null
        _uiState.update {
            it.copy(
                scanReview = null, dialogOpen = false, scanPin = null,
                pendingParse = null, pendingImagePath = null,
            )
        }
    }

    /**
     * Lot-vs-receiving dispatch (web useScanMatchers apply), wrapped in the shared
     * action runner. [qty] is the matchPicking-validated scan quantity — do not
     * re-run parseManual for it.
     */
    private fun applyPicked(pin: ScanMatcher.PinnedAllocation, fields: ScanPrimitives.OcrInput, qty: Int) =
        runAction(toastKeyAfterReload = "common_scan_success", scanApply = true) { actorId ->
            if (pin.receivingOrderId != null) {
                val f = ancillaryFields(fields)
                pickingSource.applyOcrPick(
                    pin.receivingOrderId, pin.pickingItemId, qty,
                    f.dateCode, f.lotCode, f.coo, f.cow, actorId,
                )
            } else {
                val allocationId = pin.allocationId ?: throw LocalizedException("missing_allocation")
                pickingSource.scanAllocation(allocationId, qty, actorId)
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
                        pendingParse = if (scanApply) null else it.pendingParse,
                        pendingImagePath = if (scanApply) null else it.pendingImagePath,
                    )
                }
                reload().join()
                val toastKey = when {
                    toastKeyAfterReload == null -> null
                    scanApply -> toastKeyAfterReload
                    _uiState.value.detail?.measuringTaskId != null -> toastKeyAfterReload
                    else -> null
                }
                if (toastKey != null) {
                    _uiState.update { it.copy(toastKey = toastKey, toastArgs = emptyList()) }
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
            }
        }
    }

    companion object {
        /** matchPicking/findMatchingAllocation are pure — the candidate lambdas are never used. */
        private val PURE_MATCHER = ScanMatcher({ _, _, _ -> emptyList() }, { _, _ -> emptyList() })

        private val EMPTY_CANDIDATES = OcrLabelParser.CandidateOptions(
            emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(),
        )

        private fun toPin(allocation: PickingAllocationDetail, item: PickingItemDetail) =
            ScanMatcher.PinnedAllocation(
                allocationId = allocation.id,
                pickingItemId = item.id,
                partNo = ScanPrimitives.normalize(item.partNo ?: ""),
                allocationQty = allocation.qty,
                // POC simplification: the web derives scanned-per-allocation from packages'
                // source ids; 0 keeps findMatchingAllocation's room check passing for the
                // common case (web re-validates on apply).
                scannedQty = 0,
                receivingOrderId = allocation.receivingOrderId,
            )

        /** Wedge path: all of the order's allocations as match targets (web parity). */
        private fun findMatchingAllocation(
            fields: ScanPrimitives.OcrInput,
            detail: PickingOrderDetail?,
        ): ScanMatcher.PinnedAllocation? {
            if (detail == null) return null
            val all = detail.items.flatMap { item ->
                item.allocations.map { allocation -> toPin(allocation, item) }
            }
            return PURE_MATCHER.findMatchingAllocation(fields, all)
        }

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
                    container.pickingRepository.getPickingOrderDetail(orderId)?.supplierCode
                }
                capture.barcodes.firstNotNullOfOrNull { barcode ->
                    QrParser.parseQrCapture(barcode.value, templates, targets, supplierCode)
                } ?: OcrLabelParser.parseAndIdentify(capture, targets)
            }
            return object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    if (modelClass.isAssignableFrom(PickingDetailViewModel::class.java)) {
                        return PickingDetailViewModel(
                            orderId,
                            container.pickingRepository,
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
