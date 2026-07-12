package com.docpal.warehousepda.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.data.SessionRepository
import com.docpal.warehousepda.domain.model.User
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class HomeUiState(
    val user: User? = null,
    val loading: Boolean = true,
    val loggedOut: Boolean = false,
)

class HomeViewModel(
    private val sessionRepository: SessionRepository,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(HomeUiState())
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            // SessionRepository clears a stale stored id as part of the read.
            val user = withContext(io) { sessionRepository.currentUser() }
            if (user == null) {
                _uiState.update { it.copy(loading = false, loggedOut = true) }
            } else {
                _uiState.update { it.copy(user = user, loading = false) }
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            withContext(io) { sessionRepository.logout() }
            _uiState.update { it.copy(loggedOut = true) }
        }
    }
}
