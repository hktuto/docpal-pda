package com.docpal.warehousepda.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        UserEntity::class,
        SupplierEntity::class,
        PartEntity::class,
        ShelfEntity::class,
        ReceivingOrderEntity::class,
        ReceivingInvoiceEntity::class,
        ReceivingInvoiceItemEntity::class,
        ReceivingItemMismatchEntity::class,
        PickingOrderEntity::class,
        PickingItemEntity::class,
        PickingPackageEntity::class,
        InventoryLotEntity::class,
        InventoryLotSourceEntity::class,
        AllocationEntity::class,
        MeasuringTaskEntity::class,
        ShippingBoxEntity::class,
        ShelfBoxEntity::class,
        PutAwayScanEntity::class,
        TransitionLogEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class AppDatabase : RoomDatabase() {

    abstract fun userDao(): UserDao

    abstract fun receivingDao(): ReceivingDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun getInstance(context: Context): AppDatabase =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: build(context, inMemory = false).also { INSTANCE = it }
            }

        fun build(context: Context, inMemory: Boolean): AppDatabase {
            val builder = if (inMemory) {
                Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java)
            } else {
                Room.databaseBuilder(context.applicationContext, AppDatabase::class.java, "warehouse.db")
            }
            return builder
                .addCallback(SeedCallback(context.applicationContext))
                .fallbackToDestructiveMigration() // POC: no shipped data to migrate
                .build()
        }
    }

    private class SeedCallback(private val context: Context) : Callback() {
        override fun onCreate(db: SupportSQLiteDatabase) {
            // seed.sql has exactly one INSERT per line, no embedded newlines
            // (the export script flattens them).
            db.beginTransaction()
            try {
                context.assets.open("seed.sql").bufferedReader().useLines { lines ->
                    lines.map { it.trim() }
                        .filter { it.isNotEmpty() }
                        .forEach { db.execSQL(it.removeSuffix(";")) }
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }
    }
}
