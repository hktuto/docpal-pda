package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.model.User

class AuthRepository(private val db: AppDatabase) {

    suspend fun login(username: String, password: String): User {
        val row = db.userDao().findByUsername(username)
            ?: throw LocalizedException("invalid_username_or_password")
        // Plain-text compare — demo-only, mirrors the web adapter.
        if (row.passwordHash != password) {
            throw LocalizedException("invalid_username_or_password")
        }
        return User(
            id = row.id,
            username = row.username,
            displayName = row.displayName,
            role = row.role,
            createdAt = row.createdAt,
        )
    }

    suspend fun userById(id: String): User? {
        val row = db.userDao().findById(id) ?: return null
        return User(
            id = row.id,
            username = row.username,
            displayName = row.displayName,
            role = row.role,
            createdAt = row.createdAt,
        )
    }
}
