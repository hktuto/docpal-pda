package com.docpal.warehousepda.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Query

@Dao
interface ScanDao {

    @Query("SELECT code, qrcode_template, qrcode_qty_encoding FROM suppliers WHERE qrcode_template IS NOT NULL")
    fun supplierQrTemplates(): List<SupplierQrTemplateRow>
}

data class SupplierQrTemplateRow(
    val code: String,
    @ColumnInfo(name = "qrcode_template") val qrcodeTemplate: String,
    @ColumnInfo(name = "qrcode_qty_encoding") val qrcodeQtyEncoding: String?,
)
