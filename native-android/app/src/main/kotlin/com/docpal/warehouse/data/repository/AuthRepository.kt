package com.docpal.warehouse.data.repository

import com.docpal.warehouse.data.local.dao.UserDao
import com.docpal.warehouse.domain.model.User
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AuthRepository @Inject constructor(
    private val userDao: UserDao
) {

    suspend fun login(username: String, password: String): Result<User> {
        val entity = userDao.getByUsername(username.trim())
            ?: return Result.failure(IllegalArgumentException("Invalid credentials"))

        if (entity.passwordHash != password) {
            return Result.failure(IllegalArgumentException("Invalid credentials"))
        }

        return Result.success(
            User(
                id = entity.id,
                username = entity.username,
                displayName = entity.displayName,
                role = entity.role
            )
        )
    }
}
