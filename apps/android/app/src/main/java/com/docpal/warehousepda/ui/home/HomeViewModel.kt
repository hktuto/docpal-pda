package com.docpal.warehousepda.ui.home

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.data.SessionStore
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.AuthRepository
import com.docpal.warehousepda.domain.model.User
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class HomeUiState(
    val user: User? = null,
    val loading: Boolean = true,
    val loggedOut: Boolean = false,
)

class HomeViewModel(application: Application) : AndroidViewModel(application) {

    private val db by lazy { AppDatabase.getInstance(application) }
    private val authRepository by lazy { AuthRepository(db) }
    private val sessionStore = SessionStore(application)

    private val _uiState = MutableStateFlow(HomeUiState())
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            val storedId = sessionStore.userId.first()
            val user = if (storedId != null) {
                withContext(Dispatchers.IO) { authRepository.userById(storedId) }
            } else {
                null
            }
            if (user == null) {
                sessionStore.setUserId(null)
                _uiState.update { it.copy(loading = false, loggedOut = true) }
            } else {
                _uiState.update { it.copy(user = user, loading = false) }
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            sessionStore.setUserId(null)
            _uiState.update { it.copy(loggedOut = true) }
        }
    }
}
