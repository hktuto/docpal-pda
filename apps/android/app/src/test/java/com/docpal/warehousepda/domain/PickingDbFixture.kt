package com.docpal.warehousepda.domain

import androidx.sqlite.db.SimpleSQLiteQuery
import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.offMainThread
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals

/**
 * Shared synthetic-fixture helpers for the picking domain repository tests
 * (PickingRepositoryTest, ReportPickingIssuesTest, CancelBoxAndFinishTest):
 * raw SQL exec/queries, the LocalizedException code assertion, and the
 * deterministic-id row inserters. All take the test's in-memory db explicitly
 * so the fixtures stay seed-isolated per test class.
 */
internal fun exec(db: AppDatabase, sql: String) = offMainThread {
    db.openHelper.writableDatabase.execSQL(sql)
}

internal fun intQuery(db: AppDatabase, sql: String): Int = offMainThread {
    db.query(SimpleSQLiteQuery(sql)).use { c ->
        c.moveToFirst()
        c.getInt(0)
    }
}

internal fun stringQuery(db: AppDatabase, sql: String): String? = offMainThread {
    db.query(SimpleSQLiteQuery(sql)).use { c ->
        if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
    }
}

/** Asserts [block] throws LocalizedException with [code]; returns it for param assertions. */
internal fun expectCode(code: String, block: suspend () -> Unit): LocalizedException = runBlocking {
    try {
        block()
        throw AssertionError("expected LocalizedException '$code'")
    } catch (e: LocalizedException) {
        assertEquals(code, e.code)
        e
    }
}

internal fun insertPickingOrder(db: AppDatabase, id: String, refNo: String, status: String) {
    exec(
        db,
        "INSERT INTO picking_orders (id, ref_no, supplier_id, delivery_date, po_no, required_date_code_notice, ship_to, destination_country, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark, issue_reported_at, issue_reported_by, status, created_at, updated_at) " +
            "VALUES ('$id', '$refNo', NULL, 1783872000000, NULL, NULL, 'GZ', 'China', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '$status', 1783779245783, 1783779245783)"
    )
}

internal fun insertPickingItem(
    db: AppDatabase,
    id: String,
    orderId: String,
    partId: String,
    qty: Int,
    allocated: Int = 0,
    pickedQty: Int = 0,
) {
    exec(
        db,
        "INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, allocated_qty, required_date_code, source_shelf_code) " +
            "VALUES ('$id', '$orderId', '$partId', $qty, $pickedQty, $allocated, NULL, NULL)"
    )
}

internal fun insertPackage(db: AppDatabase, id: String, itemId: String, orderId: String, qty: Int, boxId: String?) {
    exec(
        db,
        "INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, date_code, lot_code, coo, cow, verified, created_at) " +
            "VALUES ('$id', '$itemId', '$orderId', 'inventory_lot', 'no-such-lot', $qty, ${boxId?.let { "'$it'" } ?: "NULL"}, NULL, NULL, NULL, NULL, 0, 1783779245783)"
    )
}

internal fun insertBox(db: AppDatabase, id: String, orderId: String, status: String) {
    exec(
        db,
        "INSERT INTO shipping_boxes (id, picking_order_id, measuring_task_id, status, gross_weight, net_weight, destination_country, box_size, created_at) " +
            "VALUES ('$id', '$orderId', NULL, '$status', NULL, NULL, NULL, NULL, 1783779245783)"
    )
}
