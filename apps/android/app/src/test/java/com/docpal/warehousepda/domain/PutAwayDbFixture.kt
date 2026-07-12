package com.docpal.warehousepda.domain

import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Synthetic-fixture inserters for the phase-3 put-away repository tests
 * (PutAwayListRepositoryTest, PutAwayDetailRepositoryTest). These take the raw
 * [SupportSQLiteDatabase] so a test can batch inserts inside one offMainThread
 * block; the AppDatabase-based helpers in PickingDbFixture.kt (insertReceivingOrder,
 * insertPart, insertPickingOrder, insertPickingItem, insertAllocation) are reused
 * as-is. Column sets verified against ReceivingEntities.kt / MeasuringEntities.kt.
 */
internal fun insertReceivingInvoice(
    db: SupportSQLiteDatabase,
    id: String,
    orderId: String,
    supplierInvoiceNo: String = "INV-$id",
) {
    db.execSQL(
        "INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id) " +
            "VALUES (${sqlQuote(id)}, ${sqlQuote(orderId)}, ${sqlQuote(supplierInvoiceNo)}, NULL)"
    )
}

internal fun insertReceivingInvoiceItem(
    db: SupportSQLiteDatabase,
    id: String,
    invoiceId: String,
    partId: String,
    qty: Int,
    receivedQty: Int = qty,
    pickedQty: Int = 0,
    putAwayQty: Int = 0,
    dateCode: String? = null,
    lotCode: String? = null,
    coo: String? = null,
    cow: String? = null,
) {
    db.execSQL(
        "INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, po_no, po_line, qty, received_qty, picked_qty, put_away_qty, box_id, date_code, lot_code, coo, cow) " +
            "VALUES (${sqlQuote(id)}, ${sqlQuote(invoiceId)}, ${sqlQuote(partId)}, NULL, NULL, $qty, $receivedQty, $pickedQty, $putAwayQty, NULL, ${sqlQuote(dateCode)}, ${sqlQuote(lotCode)}, ${sqlQuote(coo)}, ${sqlQuote(cow)})"
    )
}

/** Unboxed scan when [shelfBoxId] is null; verified/verified_at default like the seed. */
internal fun insertPutAwayScan(
    db: SupportSQLiteDatabase,
    id: String,
    itemId: String,
    partId: String,
    qty: Int,
    shelfBoxId: String? = null,
    dateCode: String? = null,
    lotCode: String? = null,
    coo: String? = null,
    cow: String? = null,
) {
    db.execSQL(
        "INSERT INTO put_away_scans (id, receiving_invoice_item_id, part_id, qty, date_code, lot_code, coo, cow, shelf_box_id, verified, verified_at, created_at) " +
            "VALUES (${sqlQuote(id)}, ${sqlQuote(itemId)}, ${sqlQuote(partId)}, $qty, ${sqlQuote(dateCode)}, ${sqlQuote(lotCode)}, ${sqlQuote(coo)}, ${sqlQuote(cow)}, ${sqlQuote(shelfBoxId)}, 0, NULL, 1783779245783)"
    )
}

internal fun insertShelfBox(
    db: SupportSQLiteDatabase,
    id: String,
    orderId: String,
    shelfCode: String?,
    status: String = "open",
) {
    db.execSQL(
        "INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at) " +
            "VALUES (${sqlQuote(id)}, ${sqlQuote(orderId)}, ${sqlQuote(shelfCode)}, ${sqlQuote(status)}, 1783779245783)"
    )
}
