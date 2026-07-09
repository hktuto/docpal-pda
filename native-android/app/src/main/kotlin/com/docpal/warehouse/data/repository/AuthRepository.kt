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
        require(password.isNotEmpty()) { "Password is required" }

        val entity = userDao.getByUsername(trimmedUsername)
            ?: throw IllegalArgumentException("Invalid credentials")

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
