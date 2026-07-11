package com.docpal.warehousepda.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "session")

class SessionStore(private val context: Context) {

    private val userIdKey = stringPreferencesKey("user_id")

    val userId: Flow<String?> = context.dataStore.data.map { prefs -> prefs[userIdKey] }

    suspend fun setUserId(id: String?) {
        context.dataStore.edit { prefs ->
            if (id == null) prefs.remove(userIdKey) else prefs[userIdKey] = id
        }
    }
}
