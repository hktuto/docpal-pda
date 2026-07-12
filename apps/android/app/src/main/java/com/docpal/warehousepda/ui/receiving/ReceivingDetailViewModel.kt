package com.docpal.warehousepda.ui.receiving

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.AppContainer
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.MismatchInfo
import com.docpal.warehousepda.domain.model.ReceivingOrderDetail
import com.docpal.warehousepda.domain.model.User
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

data class ReceivingDetailUiState(
    val loading: Boolean = true,
    val detail: ReceivingOrderDetail? = null,
    val errorKey: String? = null,
    val tab: Int = 0,
    val currentUserId: String? = null,
    val actionInProgress: Boolean = false,
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
) : ViewModel() {

    private val _uiState = MutableStateFlow(ReceivingDetailUiState())
    val uiState: StateFlow<ReceivingDetailUiState> = _uiState.asStateFlow()

    private var loadJob: Job? = null

    init {
        reload()
    }

    fun setTab(tab: Int) = _uiState.update { it.copy(tab = tab) }

    fun reload() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update { it.copy(loading = true) }
            try {
                val detail = withContext(io) { receivingSource.getOrderDetail(orderId) }
                val userId = withContext(io) { sessionSource.currentUser()?.id }
                _uiState.update {
                    it.copy(loading = false, detail = detail, currentUserId = userId, errorKey = null)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: LocalizedException) {
                _uiState.update { it.copy(loading = false, errorKey = e.code) }
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

    private fun runAction(block: suspend (actorId: String) -> Unit) {
        viewModelScope.launch {
            _uiState.update { it.copy(actionInProgress = true, errorKey = null) }
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
                _uiState.update { it.copy(actionInProgress = false, errorKey = e.code) }
            } catch (e: Exception) {
                _uiState.update { it.copy(actionInProgress = false) }
            }
        }
    }

    companion object {
        /** Per-orderId factory; screens build it from the app container. */
        fun provideFactory(container: AppContainer, orderId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    if (modelClass.isAssignableFrom(ReceivingDetailViewModel::class.java)) {
                        return ReceivingDetailViewModel(
                            orderId,
                            container.receivingRepository,
                            container.mismatchRepository,
                            container.sessionRepository,
                        ) as T
                    }
                    throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
                }
            }
    }
}
