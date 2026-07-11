package com.docpal.warehousepda.domain

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AuthRepositoryTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: AuthRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = AppDatabase.build(context, inMemory = true)
        repo = AuthRepository(db)
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun `login succeeds with demo credentials`() = runTest {
        val user = repo.login("operator", "DocPal2026!")
        assertEquals("operator", user.username)
        assertEquals("operator", user.role)
    }

    @Test
    fun `login fails with wrong password`() {
        val e = assertThrows(LocalizedException::class.java) {
            runBlocking { repo.login("operator", "wrong") }
        }
        assertEquals("invalid_username_or_password", e.code)
    }

    @Test
    fun `login fails with unknown user`() {
        val e = assertThrows(LocalizedException::class.java) {
            runBlocking { repo.login("nobody", "DocPal2026!") }
        }
        assertEquals("invalid_username_or_password", e.code)
    }

    @Test
    fun `userById returns seeded user or null`() = runTest {
        val operator = repo.login("operator", "DocPal2026!")
        val found = repo.userById(operator.id)
        assertNotNull(found)
        assertEquals(operator.id, found!!.id)
        assertEquals("operator", found.username)
        assertNull(repo.userById("nonexistent"))
    }
}
