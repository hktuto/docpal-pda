package com.docpal.warehousepda.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionRepositoryTest {

    private lateinit var db: AppDatabase
    private lateinit var repo: SessionRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        // Same pattern as SeedImportTest: attaches the SeedCallback so the
        // demo seed data (assets/seed.sql) exists.
        db = AppDatabase.build(context, inMemory = true)
        repo = SessionRepository(SessionStore(context), db.userDao())
        offMainThread { repo.logout() }
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `currentUser returns seeded operator after login id stored`() = offMainThread {
        val operator = runBlocking { db.userDao().findByUsername("operator")!! }
        repo.setLoggedInUserId(operator.id)
        val user = repo.currentUser()
        assertEquals("operator", user?.username)
    }

    @Test
    fun `currentUser clears stale stored id and returns null`() = offMainThread {
        repo.setLoggedInUserId("does-not-exist")
        assertNull(repo.currentUser())
        assertNull(repo.storedUserId())
    }

    @Test
    fun `logout clears stored id`() = offMainThread {
        val operator = runBlocking { db.userDao().findByUsername("operator")!! }
        repo.setLoggedInUserId(operator.id)
        repo.logout()
        assertNull(repo.currentUser())
    }
}
