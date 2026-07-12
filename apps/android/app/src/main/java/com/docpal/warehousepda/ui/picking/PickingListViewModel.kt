package com.docpal.warehousepda.ui.picking

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.PickingIssueInput
import com.docpal.warehousepda.domain.model.PickingOrderSummary
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

/**
 * Read/mutation slice of `PickingRepository` the list screen needs
 * (web pgliteWarehouse listOrders + reportPickingOrderIssues).
 */
interface PickingListSource {
    suspend fun listOrders(): List<PickingOrderSummary>
    suspend fun reportIssues(
        entries: List<Pair<String, String?>>,
        input: PickingIssueInput,
        actorId: String,
    ): Pair<Int, Int>
}

data class PickingListUiState(
    val search: String = "",
    val loading: Boolean = true,
    val orders: List<PickingOrderSummary> = emptyList(),
    val selectedIds: Set<String> = emptySet(),
    val reporting: Boolean = false,
    val errorKey: String? = null,
    // LocalizedException.params, passed as %1$s format args when errorKey renders.
    val errorArgs: List<String> = emptyList(),
    val toastKey: String? = null,     // "issue_reported" -> summary toast with reported/skipped
    val toastArgs: List<Int> = emptyList(),
) {
    /** Client-side search over refNo + supplierName, matching the web list page. */
    val visibleOrders: List<PickingOrderSummary>
        get() {
            val q = search.trim().lowercase()
            if (q.isEmpty()) return orders
            return orders.filter {
                it.refNo.lowercase().contains(q) || (it.supplierName?.lowercase()?.contains(q) == true)
            }
        }

    val selectedOrders: List<PickingOrderSummary> get() = orders.filter { it.id in selectedIds }
}

class PickingListViewModel(
    private val source: PickingListSource,
    private val sessionSource: SessionSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(PickingListUiState())
    val uiState: StateFlow<PickingListUiState> = _uiState.asStateFlow()

    // First load is triggered by the screen's ON_RESUME observer (OnResumeEffect).
    private var loadJob: Job? = null

    fun setSearch(value: String) = _uiState.update { it.copy(search = value) }

    /** Only pending/picking orders are selectable (web isSelectable); others are ignored. */
    fun toggleSelection(id: String) {
        val order = _uiState.value.orders.firstOrNull { it.id == id } ?: return
        if (order.status != "pending" && order.status != "picking") return
        _uiState.update {
            val next = it.selectedIds.toMutableSet()
            if (!next.add(id)) next.remove(id)
            it.copy(selectedIds = next)
        }
    }

    fun clearSelection() = _uiState.update { it.copy(selectedIds = emptySet()) }

    /** Clears a surfaced error — called when the error's UI surface is dismissed/replaced. */
    fun clearError() = _uiState.update { it.copy(errorKey = null, errorArgs = emptyList()) }

    fun clearToast() = _uiState.update { it.copy(toastKey = null, toastArgs = emptyList()) }

    /** Race-safe reload (cancels any in-flight load); selection survives reloads like the web Set. */
    fun reload() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update { it.copy(loading = true) }
            try {
                val orders = withContext(io) { source.listOrders() }
                _uiState.update { it.copy(loading = false, orders = orders) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _uiState.update { it.copy(loading = false) }
            }
        }
    }

    /**
     * Batch issue report (web onReportSaved): one entry per selected order with its
     * trimmed remark. Success clears the selection, reloads, and raises the summary toast;
     * repository errors surface via errorKey while the dialog stays open.
     */
    fun reportIssues(
        reason: String,
        qty: Int?,
        packSize: Int?,
        note: String?,
        remarks: Map<String, String>,
    ) {
        if (_uiState.value.reporting) return
        viewModelScope.launch {
            _uiState.update { it.copy(reporting = true, errorKey = null, errorArgs = emptyList()) }
            try {
                val (reported, skipped) = withContext(io) {
                    val actorId = sessionSource.currentUser()?.id
                        ?: throw LocalizedException("operator_not_signed_in")
                    val entries = _uiState.value.selectedOrders.map {
                        it.id to remarks[it.id]?.trim()?.takeIf { r -> r.isNotEmpty() }
                    }
                    source.reportIssues(
                        entries,
                        PickingIssueInput(reason, qty, packSize, note?.trim()?.takeIf { it.isNotEmpty() }),
                        actorId,
                    )
                }
                _uiState.update {
                    it.copy(
                        reporting = false,
                        selectedIds = emptySet(),
                        toastKey = "issue_reported",
                        toastArgs = listOf(reported, skipped),
                    )
                }
                reload()
            } catch (e: CancellationException) {
                _uiState.update { it.copy(reporting = false) }
                throw e
            } catch (e: LocalizedException) {
                _uiState.update {
                    it.copy(reporting = false, errorKey = e.code, errorArgs = e.params.values.toList())
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(reporting = false) }
            }
        }
    }
}
