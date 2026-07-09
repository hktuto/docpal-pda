package com.docpal.warehouse.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.docpal.warehouse.data.repository.AuthRepository
import com.docpal.warehouse.domain.model.User
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class LoginViewModel @Inject constructor(
    private val authRepository: AuthRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow<LoginUiState>(LoginUiState.Idle)
    val uiState: StateFlow<LoginUiState> = _uiState

    fun login(username: String, password: String) {
        _uiState.value = LoginUiState.Loading
        viewModelScope.launch {
            _uiState.value = try {
                LoginUiState.Success(authRepository.login(username, password))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                LoginUiState.Error("Invalid username or password")
            }
        }
    }

    fun reset() {
        _uiState.value = LoginUiState.Idle
    }

    sealed class LoginUiState {
        object Idle : LoginUiState()
        object Loading : LoginUiState()
        data class Success(val user: User) : LoginUiState()
        data class Error(val message: String) : LoginUiState()
    }
}
