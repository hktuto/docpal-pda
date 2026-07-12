package com.docpal.warehousepda.domain

import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Synthetic-fixture inserters for the phase-3 put-away repository tests
 * (PutAwayListRepositoryTest, PutAwayDetailRepositoryTest). These take the raw
 * [SupportSQLiteDatabase] so a test can batch inserts inside one offMainThread
 * block; the AppDatabase-based helpers in PickingDbFixture.kt (insertReceivingOrder,
 * insertPart, insertPickingOrder, insertPickingItem, insertAllocation) are reused
 * as-is. Column sets verified against ReceivingEntities.kt / MeasuringEntities.kt /
 * ReferenceEntities.kt.
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
    createdAt: Long = 1783779245783,
    verified: Int = 0,
    verifiedAt: Long? = null,
) {
    db.execSQL(
        "INSERT INTO put_away_scans (id, receiving_invoice_item_id, part_id, qty, date_code, lot_code, coo, cow, shelf_box_id, verified, verified_at, created_at) " +
            "VALUES (${sqlQuote(id)}, ${sqlQuote(itemId)}, ${sqlQuote(partId)}, $qty, ${sqlQuote(dateCode)}, ${sqlQuote(lotCode)}, ${sqlQuote(coo)}, ${sqlQuote(cow)}, ${sqlQuote(shelfBoxId)}, $verified, ${verifiedAt ?: "NULL"}, $createdAt)"
    )
}

internal fun insertShelfBox(
    db: SupportSQLiteDatabase,
    id: String,
    orderId: String,
    shelfCode: String?,
    status: String = "open",
    createdAt: Long = 1783779245783,
) {
    db.execSQL(
        "INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at) " +
            "VALUES (${sqlQuote(id)}, ${sqlQuote(orderId)}, ${sqlQuote(shelfCode)}, ${sqlQuote(status)}, $createdAt)"
    )
}

internal fun insertSupplier(db: SupportSQLiteDatabase, id: String, code: String, name: String) {
    db.execSQL(
        "INSERT INTO suppliers (id, code, name) " +
            "VALUES (${sqlQuote(id)}, ${sqlQuote(code)}, ${sqlQuote(name)})"
    )
}

internal fun insertShelf(db: SupportSQLiteDatabase, code: String, zone: String?) {
    db.execSQL(
        "INSERT INTO shelves (code, zone) VALUES (${sqlQuote(code)}, ${sqlQuote(zone)})"
    )
}

/** Audit row; used for the cancelled-SBOX-id fixture (ids kept forever in transition_logs). Column set verified against AuditEntities.kt. */
internal fun insertTransitionLog(
    db: SupportSQLiteDatabase,
    entityType: String,
    entityId: String,
    fromStatus: String?,
    toStatus: String,
    actorId: String?,
    id: String = "log-$entityType-$entityId-$toStatus",
    createdAt: Long = 1783779245783,
) {
    db.execSQL(
        "INSERT INTO transition_logs (id, entity_type, entity_id, from_state, to_state, actor_id, metadata, created_at) " +
            "VALUES (${sqlQuote(id)}, ${sqlQuote(entityType)}, ${sqlQuote(entityId)}, ${sqlQuote(fromStatus)}, ${sqlQuote(toStatus)}, ${sqlQuote(actorId)}, NULL, $createdAt)"
    )
}
