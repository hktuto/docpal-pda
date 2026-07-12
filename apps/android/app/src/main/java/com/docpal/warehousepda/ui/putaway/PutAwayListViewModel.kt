package com.docpal.warehousepda.ui.putaway

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PutAwayCandidate
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

/** Read-only slice of the put-away repository the list screen needs. Implemented by `PutAwayRepository`. */
interface PutAwayListSource {
    suspend fun listCandidates(): List<PutAwayCandidate>
}

data class PutAwayListUiState(
    val loading: Boolean = true,
    val orders: List<PutAwayCandidate> = emptyList(),
    val errorKey: String? = null,
    // LocalizedException.params, passed as %1$s format args when errorKey renders.
    val errorArgs: List<String> = emptyList(),
)

class PutAwayListViewModel(
    private val source: PutAwayListSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(PutAwayListUiState())
    val uiState: StateFlow<PutAwayListUiState> = _uiState.asStateFlow()

    // First load is triggered by the screen's ON_RESUME observer (OnResumeEffect).
    private var loadJob: Job? = null

    /** Race-safe reload (cancels any in-flight load), same pattern as the other list ViewModels. */
    fun reload() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update { it.copy(loading = true, errorKey = null, errorArgs = emptyList()) }
            try {
                val orders = withContext(io) { source.listCandidates() }
                _uiState.update { it.copy(loading = false, orders = orders) }
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
}
