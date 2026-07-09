package com.docpal.warehouse.data.local.dao

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.docpal.warehouse.data.local.AppDatabase
import com.docpal.warehouse.data.local.entity.UserEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class UserDaoTest {

    private lateinit var db: AppDatabase
    private lateinit var dao: UserDao

    @Before
    fun setup() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        dao = db.userDao()
    }

    @After
    fun teardown() {
        db.close()
    }

    @Test
    fun insert_and_retrieve_user() = runTest {
        val user = UserEntity(
            id = "1",
            username = "operator",
            passwordHash = "DocPal2026!",
            displayName = "Operator",
            role = "operator",
            createdAt = "2026-01-01T00:00:00Z"
        )
        dao.insert(user)

        val found = dao.getByUsername("operator")

        assertNotNull(found)
        assertEquals(user, found)
    }

    @Test
    fun count_returns_zero_when_empty() = runTest {
        assertEquals(0, dao.count())
    }
}
