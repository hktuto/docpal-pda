package com.docpal.warehouse.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import com.docpal.warehouse.data.local.dao.UserDao
import com.docpal.warehouse.data.local.entity.UserEntity

@Database(
    entities = [UserEntity::class],
    version = 2,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun userDao(): UserDao
}
