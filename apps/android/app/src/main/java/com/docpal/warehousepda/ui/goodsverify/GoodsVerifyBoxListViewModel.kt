package com.docpal.warehousepda.ui.goodsverify

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.AppContainer
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.VerifyBoxSummary
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

/** Read-only slice of the goods-verify repository the shelf box list screen needs. Implemented by `GoodsVerifyRepository`. */
interface GoodsVerifyBoxListSource {
    suspend fun listBoxes(shelfCode: String): List<VerifyBoxSummary>
}

data class GoodsVerifyBoxListUiState(
    val loading: Boolean = true,
    val boxes: List<VerifyBoxSummary> = emptyList(),
    val errorKey: String? = null,
    // LocalizedException.params, passed as %1$s format args when errorKey renders.
    val errorArgs: List<String> = emptyList(),
)

class GoodsVerifyBoxListViewModel(
    private val shelfCode: String,
    private val source: GoodsVerifyBoxListSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(GoodsVerifyBoxListUiState())
    val uiState: StateFlow<GoodsVerifyBoxListUiState> = _uiState.asStateFlow()

    // First load is triggered by the screen's ON_RESUME observer (OnResumeEffect).
    private var loadJob: Job? = null

    /** Race-safe reload (cancels any in-flight load), same pattern as the other list ViewModels. */
    fun reload() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update { it.copy(loading = true, errorKey = null, errorArgs = emptyList()) }
            try {
                val boxes = withContext(io) { source.listBoxes(shelfCode) }
                _uiState.update { it.copy(loading = false, boxes = boxes) }
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

    companion object {
        /** Per-shelfCode factory; the screen builds it from the app container. */
        fun provideFactory(container: AppContainer, shelfCode: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    if (modelClass.isAssignableFrom(GoodsVerifyBoxListViewModel::class.java)) {
                        return GoodsVerifyBoxListViewModel(shelfCode, container.goodsVerifyRepository) as T
                    }
                    throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
                }
            }
    }
}
