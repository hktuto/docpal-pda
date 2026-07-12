package com.docpal.warehousepda.data

import com.docpal.warehousepda.data.db.UserDao
import com.docpal.warehousepda.domain.model.User
import kotlinx.coroutines.runBlocking

/**
 * Single source of truth for the signed-in user.
 *
 * Wraps [SessionStore] (DataStore-backed user id) and [UserDao]. A stored id
 * that no longer resolves to a user row (e.g. after a destructive migration)
 * is cleared on read so callers never see a dangling session.
 */
class SessionRepository(
    private val sessionStore: SessionStore,
    private val userDao: UserDao,
) {

    /** Blocking read — call from a background thread (repositories do this inside Dispatchers.IO). */
    fun currentUser(): User? {
        val id = sessionStore.userIdBlocking() ?: return null
        val entity = runBlocking { userDao.findById(id) }
        if (entity == null) {
            sessionStore.clearBlocking()
            return null
        }
        return User(
            id = entity.id,
            username = entity.username,
            displayName = entity.displayName,
            role = entity.role,
            createdAt = entity.createdAt,
        )
    }

    /** Blocking read of the raw stored id (test support + edge cases). */
    fun storedUserId(): String? = sessionStore.userIdBlocking()

    fun setLoggedInUserId(id: String) = sessionStore.setUserIdBlocking(id)

    fun logout() = sessionStore.clearBlocking()
}
