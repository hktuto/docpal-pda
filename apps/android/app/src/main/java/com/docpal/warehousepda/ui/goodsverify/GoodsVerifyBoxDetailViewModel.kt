package com.docpal.warehousepda.ui.goodsverify

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.AppContainer
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.VerifyBoxDetail
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
) {
    /** Web: mark-verified shows only for an unverified box whose items are all verified. */
    val canMarkVerified: Boolean get() =
        detail != null && detail.status != "verified" && detail.allVerified
}

/**
 * Loads the box detail in `init` (the first query must be testable without Compose);
 * the screen still calls [reload] via OnResumeEffect. Mirrors PutAwayDetailViewModel,
 * minus the scan machinery (Task 8 adds it).
 */
class GoodsVerifyBoxDetailViewModel(
    private val boxId: String,
    private val source: GoodsVerifyBoxDetailSource,
    private val sessionSource: SessionSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(GoodsVerifyBoxDetailUiState())
    val uiState: StateFlow<GoodsVerifyBoxDetailUiState> = _uiState.asStateFlow()

    private var loadJob: Job? = null

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
        /** Per-boxId factory; the screen builds it from the app container. */
        fun provideFactory(container: AppContainer, boxId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    if (modelClass.isAssignableFrom(GoodsVerifyBoxDetailViewModel::class.java)) {
                        return GoodsVerifyBoxDetailViewModel(
                            boxId,
                            container.goodsVerifyRepository,
                            container.sessionRepository,
                        ) as T
                    }
                    throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
                }
            }
    }
}
