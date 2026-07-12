package com.docpal.warehousepda.ui.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.docpal.warehousepda.data.SessionRepository
import com.docpal.warehousepda.domain.AuthRepository
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.User
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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

class LoginViewModel(
    private val authRepository: AuthRepository,
    private val sessionRepository: SessionRepository,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(LoginUiState())
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    init {
        // Mirrors the web middleware: an existing session skips the login screen.
        // SessionRepository clears a stale stored id as part of the read.
        viewModelScope.launch {
            try {
                val user = withContext(io) { sessionRepository.currentUser() }
                _uiState.update { it.copy(loggedInUser = user, checkingSession = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // A DataStore/Room failure must not crash or strand checkingSession.
                _uiState.update { it.copy(checkingSession = false) }
            }
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
                // A successful login persists the session inside AuthRepository.
                val user = withContext(io) { authRepository.login(username, password) }
                _uiState.update { it.copy(submitting = false, loggedInUser = user) }
            } catch (e: CancellationException) {
                _uiState.update { it.copy(submitting = false) }
                throw e
            } catch (e: LocalizedException) {
                _uiState.update { it.copy(submitting = false, errorCode = e.code) }
            } catch (e: Exception) {
                // DataStore/Room failures would otherwise escape viewModelScope
                // (crash, submitting stuck true).
                _uiState.update { it.copy(submitting = false, errorCode = "unknown") }
            }
        }
    }
}
