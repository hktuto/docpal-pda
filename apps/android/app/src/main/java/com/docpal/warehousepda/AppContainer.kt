package com.docpal.warehousepda

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.docpal.warehousepda.data.SessionRepository
import com.docpal.warehousepda.data.SessionStore
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.AuthRepository
import com.docpal.warehousepda.domain.DefaultAuthRepository
import com.docpal.warehousepda.ui.home.HomeViewModel
import com.docpal.warehousepda.ui.login.LoginViewModel

/** Manual DI container. Created once in [App]; Compose screens obtain ViewModels via [viewModelFactory]. */
class AppContainer(context: Context) {

    val db: AppDatabase = AppDatabase.getInstance(context)

    val sessionRepository: SessionRepository by lazy {
        SessionRepository(SessionStore(context), db.userDao())
    }

    val authRepository: AuthRepository by lazy {
        DefaultAuthRepository(db.userDao(), sessionRepository)
    }

    @Suppress("UNCHECKED_CAST")
    val viewModelFactory: ViewModelProvider.Factory = object : ViewModelProvider.Factory {
        override fun <T : ViewModel> create(modelClass: Class<T>): T = when {
            modelClass.isAssignableFrom(LoginViewModel::class.java) ->
                LoginViewModel(authRepository, sessionRepository) as T
            modelClass.isAssignableFrom(HomeViewModel::class.java) ->
                HomeViewModel(sessionRepository) as T
            else -> throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
    }
}
