package com.docpal.warehouse.data.repository

import com.docpal.warehouse.data.local.dao.UserDao
import com.docpal.warehouse.domain.model.User
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AuthRepository @Inject constructor(
    private val userDao: UserDao
) {

    suspend fun login(username: String, password: String): User {
        val trimmedUsername = username.trim()
        require(trimmedUsername.isNotBlank()) { "Username is required" }
        require(password.isNotBlank()) { "Password is required" }

        val entity = userDao.getByUsername(trimmedUsername)
            ?: throw IllegalArgumentException("Invalid credentials")

        // Demo-only: the seed stores passwords as plain text, matching the web demo.
        if (entity.passwordHash != password) {
            throw IllegalArgumentException("Invalid credentials")
        }

        return User(
            id = entity.id,
            username = entity.username,
            displayName = entity.displayName,
            role = entity.role
        )
    }
}
