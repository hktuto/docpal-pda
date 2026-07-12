package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.SessionRepository
import com.docpal.warehousepda.data.db.UserDao
import com.docpal.warehousepda.domain.model.User

interface AuthRepository {
    suspend fun login(username: String, password: String): User
}

class DefaultAuthRepository(
    private val userDao: UserDao,
    private val sessionRepository: SessionRepository,
) : AuthRepository {

    override suspend fun login(username: String, password: String): User {
        val row = userDao.findByUsername(username)
            ?: throw LocalizedException("invalid_username_or_password")
        // Plain-text compare — demo-only, mirrors the web adapter.
        if (row.passwordHash != password) {
            throw LocalizedException("invalid_username_or_password")
        }
        sessionRepository.setLoggedInUserId(row.id)
        return User(
            id = row.id,
            username = row.username,
            displayName = row.displayName,
            role = row.role,
            createdAt = row.createdAt,
        )
    }

    suspend fun userById(id: String): User? {
        val row = userDao.findById(id) ?: return null
        return User(
            id = row.id,
            username = row.username,
            displayName = row.displayName,
            role = row.role,
            createdAt = row.createdAt,
        )
    }
}
