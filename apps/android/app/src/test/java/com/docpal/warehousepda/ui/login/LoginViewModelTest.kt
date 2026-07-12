package com.docpal.warehousepda.ui.login

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.SessionRepository
import com.docpal.warehousepda.data.SessionStore
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.AuthRepository
import com.docpal.warehousepda.domain.LocalizedException
import com.docpal.warehousepda.domain.model.User
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    private lateinit var db: AppDatabase
    private lateinit var sessionRepository: SessionRepository

    private class FakeAuthRepository : AuthRepository {
        var nextUser: User? = User("u1", "operator", "Operator", "operator", createdAt = 0L)
        var nextError: LocalizedException? = null
        var nextFailure: Exception? = null
        var lastUsername: String? = null
        var lastPassword: String? = null

        override suspend fun login(username: String, password: String): User {
            lastUsername = username
            lastPassword = password
            nextFailure?.let { throw it }
            nextError?.let { throw it }
            return nextUser ?: throw LocalizedException("invalid_username_or_password")
        }
    }

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        sessionRepository = SessionRepository(SessionStore(context), db.userDao())
        // DataStore state can leak between test classes in the same Robolectric
        // process (AuthRepositoryTest logs in); start from a clean session.
        sessionRepository.logout()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        db.close()
    }

    @Test
    fun `login success exposes user and clears error`() = runTest(dispatcher) {
        val auth = FakeAuthRepository()
        val vm = LoginViewModel(auth, sessionRepository, dispatcher)
        // Defaults are the demo credentials; submit() is what the button calls.
        vm.submit()
        advanceUntilIdle()
        val state = vm.uiState.value
        assertEquals("operator", state.loggedInUser?.username)
        assertEquals("operator", auth.lastUsername)
        assertFalse(state.submitting)
        assertNull(state.errorCode)
    }

    @Test
    fun `login failure exposes error key`() = runTest(dispatcher) {
        val auth = FakeAuthRepository().apply {
            nextError = LocalizedException("invalid_username_or_password")
        }
        val vm = LoginViewModel(auth, sessionRepository, dispatcher)
        vm.onPasswordChange("wrong")
        vm.submit()
        advanceUntilIdle()
        val state = vm.uiState.value
        assertNull(state.loggedInUser)
        assertEquals("invalid_username_or_password", state.errorCode)
    }

    @Test
    fun `login unexpected failure resets submitting and shows generic error`() = runTest(dispatcher) {
        val auth = FakeAuthRepository().apply {
            nextFailure = RuntimeException("datastore boom")
        }
        val vm = LoginViewModel(auth, sessionRepository, dispatcher)
        vm.submit()
        advanceUntilIdle()
        val state = vm.uiState.value
        assertNull(state.loggedInUser)
        assertFalse(state.submitting)
        assertEquals("unknown", state.errorCode)
    }
}
