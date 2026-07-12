package com.docpal.warehousepda.ui.putaway

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.AppContainer
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PutAwayDetail
import com.docpal.warehousepda.ui.receiving.SessionSource
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
) : ViewModel() {

    private val _uiState = MutableStateFlow(PutAwayDetailUiState())
    val uiState: StateFlow<PutAwayDetailUiState> = _uiState.asStateFlow()

    private var loadJob: Job? = null

    init {
        reload()
    }

    /** Clears a surfaced error — called when the error's UI surface is dismissed/replaced. */
    fun clearError() = _uiState.update { it.copy(errorKey = null, errorArgs = emptyList()) }

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
                reload().join()
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
        /** Per-orderId factory; the screen builds it from the app container. */
        fun provideFactory(container: AppContainer, orderId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    if (modelClass.isAssignableFrom(PutAwayDetailViewModel::class.java)) {
                        return PutAwayDetailViewModel(
                            orderId,
                            container.putAwayRepository,
                            container.sessionRepository,
                        ) as T
                    }
                    throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
                }
            }
    }
}
