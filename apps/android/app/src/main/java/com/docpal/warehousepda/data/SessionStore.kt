package com.docpal.warehousepda.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking

private val Context.dataStore by preferencesDataStore(name = "session")

class SessionStore(private val context: Context) {

    private val userIdKey = stringPreferencesKey("user_id")

    val userId: Flow<String?> = context.dataStore.data.map { prefs -> prefs[userIdKey] }

    suspend fun setUserId(id: String?) {
        context.dataStore.edit { prefs ->
            if (id == null) prefs.remove(userIdKey) else prefs[userIdKey] = id
        }
    }

    // Blocking bridges for the repository-layer synchronous style. ViewModels
    // must not call these on the main thread — repositories call them from
    // Dispatchers.IO.
    fun userIdBlocking(): String? = runBlocking { userId.first() }

    fun setUserIdBlocking(id: String) = runBlocking { setUserId(id) }

    fun clearBlocking() = runBlocking { setUserId(null) }
}
