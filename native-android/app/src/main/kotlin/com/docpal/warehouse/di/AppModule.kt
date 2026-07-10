package com.docpal.warehouse.di

import android.content.Context
import androidx.room.Room
import androidx.sqlite.db.SupportSQLiteDatabase
import com.docpal.warehouse.data.local.AppDatabase
import com.docpal.warehouse.data.local.seed.SeedLoader
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): AppDatabase {
        return Room.databaseBuilder(
            context,
            AppDatabase::class.java,
            "warehouse-demo.db"
        )
            .fallbackToDestructiveMigration()
            .addCallback(SeedLoader.callback(context))
            .build()
    }

    @Provides
    fun provideUserDao(database: AppDatabase) = database.userDao()

    @Provides
    fun provideWritableDatabase(database: AppDatabase): SupportSQLiteDatabase {
        return database.openHelper.writableDatabase
    }
}
