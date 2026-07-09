package com.docpal.warehouse.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "users")
data class UserEntity(
    @PrimaryKey
    @ColumnInfo(name = "id")
    val id: String,

    @ColumnInfo(name = "username")
    val username: String,

    @ColumnInfo(name = "password_hash")
    val passwordHash: String,

    @ColumnInfo(name = "display_name")
    val displayName: String,

    @ColumnInfo(name = "role")
    val role: String,

    @ColumnInfo(name = "created_at")
    val createdAt: String
)
