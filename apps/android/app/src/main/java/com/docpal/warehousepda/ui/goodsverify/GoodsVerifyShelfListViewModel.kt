package com.docpal.warehousepda.ui.goodsverify

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.ShelfSummary
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

/** Read-only slice of the goods-verify repository the shelf list screen needs. Implemented by `GoodsVerifyRepository`. */
interface GoodsVerifyShelfListSource {
    suspend fun listShelves(): List<ShelfSummary>
}

data class GoodsVerifyShelfListUiState(
    val loading: Boolean = true,
    val shelves: List<ShelfSummary> = emptyList(),
    val errorKey: String? = null,
    // LocalizedException.params, passed as %1$s format args when errorKey renders.
    val errorArgs: List<String> = emptyList(),
)

class GoodsVerifyShelfListViewModel(
    private val source: GoodsVerifyShelfListSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(GoodsVerifyShelfListUiState())
    val uiState: StateFlow<GoodsVerifyShelfListUiState> = _uiState.asStateFlow()

    // First load is triggered by the screen's ON_RESUME observer (OnResumeEffect).
    private var loadJob: Job? = null

    /** Race-safe reload (cancels any in-flight load), same pattern as the other list ViewModels. */
    fun reload() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update { it.copy(loading = true, errorKey = null, errorArgs = emptyList()) }
            try {
                val shelves = withContext(io) { source.listShelves() }
                _uiState.update { it.copy(loading = false, shelves = shelves) }
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
