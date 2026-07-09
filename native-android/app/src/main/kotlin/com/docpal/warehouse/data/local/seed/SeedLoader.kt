package com.docpal.warehouse.data.local.seed

import android.content.Context
import android.util.Log
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase

object SeedLoader {

    private const val TAG = "SeedLoader"

    fun callback(context: Context): RoomDatabase.Callback {
        return object : RoomDatabase.Callback() {
            override fun onCreate(db: SupportSQLiteDatabase) {
                super.onCreate(db)
                try {
                    context.assets.open("seed/users.sql").bufferedReader().use { reader ->
                        val sql = reader.readText()
                        db.beginTransaction()
                        try {
                            sql.split(";").map { it.trim() }.filter { it.isNotEmpty() }.forEach { statement ->
                                db.execSQL(statement)
                            }
                            db.setTransactionSuccessful()
                        } finally {
                            db.endTransaction()
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to seed users", e)
                    throw e
                }
            }
        }
    }
}
