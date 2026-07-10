package com.docpal.warehouse.data.local.seed

import android.content.Context
import android.util.Log
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase

object SeedLoader {

    private const val TAG = "SeedLoader"

    private fun logCount(db: SupportSQLiteDatabase, table: String) {
        db.query("SELECT COUNT(*) FROM $table").use { cursor ->
            if (cursor.moveToFirst()) {
                Log.i(TAG, "$table rows: ${cursor.getInt(0)}")
            }
        }
    }

    private fun shouldSeed(db: SupportSQLiteDatabase): Boolean {
        return db.query("SELECT COUNT(*) FROM users").use { cursor ->
            cursor.moveToFirst() && cursor.getInt(0) == 0
        }
    }

    private fun seed(context: Context, db: SupportSQLiteDatabase) {
        Log.i(TAG, "Starting warehouse seed")
        try {
            context.assets.open("seed/warehouse.sql").bufferedReader().use { reader ->
                val sql = reader.readText()
                val statements = sql.split(";").map { it.trim() }.filter { it.isNotEmpty() }
                Log.i(TAG, "Executing ${statements.size} seed statements")
                db.beginTransaction()
                try {
                    statements.forEachIndexed { index, statement ->
                        try {
                            db.execSQL(statement)
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed at statement $index: ${statement.take(200)}", e)
                            throw e
                        }
                    }
                    db.setTransactionSuccessful()
                } finally {
                    db.endTransaction()
                }
            }
            Log.i(TAG, "Warehouse seed completed")
            logCount(db, "receiving_orders")
            logCount(db, "receiving_invoice_items")
            logCount(db, "picking_orders")
            logCount(db, "measuring_tasks")
            logCount(db, "users")
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to seed warehouse", e)
            throw e
        }
    }

    fun callback(context: Context): RoomDatabase.Callback {
        return object : RoomDatabase.Callback() {
            override fun onCreate(db: SupportSQLiteDatabase) {
                super.onCreate(db)
                seed(context, db)
            }

            override fun onOpen(db: SupportSQLiteDatabase) {
                super.onOpen(db)
                if (shouldSeed(db)) {
                    Log.i(TAG, "users table is empty, re-seeding")
                    seed(context, db)
                } else {
                    Log.i(TAG, "users table already has data, skipping seed")
                }
            }
        }
    }
}
