package com.docpal.warehousepda.ui.receiving

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.domain.model.ReceivingOrderSummary
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Read-only slice of the receiving repository the list screen needs. Implemented by `ReceivingRepository`. */
interface ReceivingListSource {
    suspend fun listOrders(filter: String): List<ReceivingOrderSummary>
}

data class ReceivingListUiState(
    val filter: String = "in_hand",
    val search: String = "",
    val loading: Boolean = true,
    val orders: List<ReceivingOrderSummary> = emptyList(),
) {
    /** Client-side search over refNo + supplierName, matching the web list page. */
    val visibleOrders: List<ReceivingOrderSummary>
        get() {
            val q = search.trim().lowercase()
            if (q.isEmpty()) return orders
            return orders.filter {
                it.refNo.lowercase().contains(q) || (it.supplierName?.lowercase()?.contains(q) == true)
            }
        }
}

class ReceivingListViewModel(
    private val source: ReceivingListSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ReceivingListUiState())
    val uiState: StateFlow<ReceivingListUiState> = _uiState.asStateFlow()

    init { reload() }

    fun setFilter(filter: String) {
        _uiState.update { it.copy(filter = filter) }
        reload()
    }

    fun setSearch(value: String) = _uiState.update { it.copy(search = value) }

    fun reload() {
        viewModelScope.launch {
            val filter = _uiState.value.filter
            _uiState.update { it.copy(loading = true) }
            val orders = withContext(io) { source.listOrders(filter) }
            _uiState.update { it.copy(loading = false, orders = orders) }
        }
    }
}
