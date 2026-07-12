package com.docpal.warehousepda.ui.picking

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.AppContainer
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PickingItemLogEntry
import com.docpal.warehousepda.domain.model.PickingOrderDetail
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
)

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
) : ViewModel() {

    private val _uiState = MutableStateFlow(PickingDetailUiState())
    val uiState: StateFlow<PickingDetailUiState> = _uiState.asStateFlow()

    private var loadJob: Job? = null

    init {
        reload()
    }

    /** Clears a surfaced error — called when the error's UI surface is dismissed/replaced. */
    fun clearError() = _uiState.update { it.copy(errorKey = null, errorArgs = emptyList()) }

    fun clearToast() = _uiState.update { it.copy(toastKey = null) }

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

    private fun runAction(
        toastKeyAfterReload: String? = null,
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
                _uiState.update { it.copy(actionInProgress = false) }
                reload().join()
                if (toastKeyAfterReload != null && _uiState.value.detail?.measuringTaskId != null) {
                    _uiState.update { it.copy(toastKey = toastKeyAfterReload) }
                }
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
                    if (modelClass.isAssignableFrom(PickingDetailViewModel::class.java)) {
                        return PickingDetailViewModel(
                            orderId,
                            container.pickingRepository,
                            container.sessionRepository,
                        ) as T
                    }
                    throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
                }
            }
    }
}
