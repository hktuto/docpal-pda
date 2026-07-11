package com.docpal.warehousepda.ui.login

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.data.SessionStore
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.AuthRepository
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.User
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class LoginUiState(
    val username: String = "operator",
    val password: String = "DocPal2026!",
    val passwordVisible: Boolean = false,
    val submitting: Boolean = false,
    val errorCode: String? = null,
    val loggedInUser: User? = null,
    val checkingSession: Boolean = true,
)

class LoginViewModel(application: Application) : AndroidViewModel(application) {

    private val db by lazy { AppDatabase.getInstance(application) }
    private val authRepository by lazy { AuthRepository(db) }
    private val sessionStore = SessionStore(application)

    private val _uiState = MutableStateFlow(LoginUiState())
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    init {
        // Mirrors the web middleware: an existing session skips the login screen.
        viewModelScope.launch {
            val storedId = sessionStore.userId.first()
            val user = if (storedId != null) {
                withContext(Dispatchers.IO) { authRepository.userById(storedId) }
            } else {
                null
            }
            if (user == null && storedId != null) {
                sessionStore.setUserId(null)
            }
            _uiState.update { it.copy(loggedInUser = user, checkingSession = false) }
        }
    }

    fun onUsernameChange(value: String) {
        _uiState.update { it.copy(username = value, errorCode = null) }
    }

    fun onPasswordChange(value: String) {
        _uiState.update { it.copy(password = value, errorCode = null) }
    }

    fun togglePasswordVisible() {
        _uiState.update { it.copy(passwordVisible = !it.passwordVisible) }
    }

    fun submit() {
        val username = _uiState.value.username.trim()
        val password = _uiState.value.password
        if (_uiState.value.submitting) return
        _uiState.update { it.copy(submitting = true, errorCode = null) }
        viewModelScope.launch {
            try {
                val user = withContext(Dispatchers.IO) {
                    authRepository.login(username, password)
                }
                sessionStore.setUserId(user.id)
                _uiState.update { it.copy(submitting = false, loggedInUser = user) }
            } catch (e: LocalizedException) {
                _uiState.update { it.copy(submitting = false, errorCode = e.code) }
            }
        }
    }
}
