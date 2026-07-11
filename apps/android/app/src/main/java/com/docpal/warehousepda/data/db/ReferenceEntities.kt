package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "users",
    indices = [Index(value = ["username"], unique = true)]
)
data class UserEntity(
    @PrimaryKey val id: String,
    val username: String,
    @ColumnInfo(name = "password_hash") val passwordHash: String,
    @ColumnInfo(name = "display_name") val displayName: String,
    @ColumnInfo(defaultValue = "operator") val role: String,
    @ColumnInfo(name = "created_at") val createdAt: Long,
)

@Entity(
    tableName = "suppliers",
    indices = [Index(value = ["code"], unique = true)]
)
data class SupplierEntity(
    @PrimaryKey val id: String,
    val code: String,
    val name: String,
    @ColumnInfo(name = "qrcode_template") val qrcodeTemplate: String?,
    @ColumnInfo(name = "qrcode_qty_encoding") val qrcodeQtyEncoding: String?,
)

@Entity(
    tableName = "parts",
    indices = [Index(value = ["part_no"], unique = true)]
)
data class PartEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "part_no") val partNo: String,
    @ColumnInfo(name = "internal_code") val internalCode: String?,
    val description: String?,
    @ColumnInfo(name = "default_coo") val defaultCoo: String?,
)

@Entity(tableName = "shelves")
data class ShelfEntity(
    @PrimaryKey val code: String,
    val zone: String?,
)
