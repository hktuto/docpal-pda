package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.domain.model.ShelfSummary
import com.docpal.warehousepda.domain.model.VerifyBoxDetail
import com.docpal.warehousepda.domain.model.VerifyBoxItem
import com.docpal.warehousepda.domain.model.VerifyBoxSummary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * Goods-verify read model: shelf list → boxes on shelf → box detail. Port of the web
 * pglite queries getShelvesWithBoxes / getShelfBoxesByShelf / getShelfBoxDetail
 * (apps/web/db/goodsVerify.ts): bool_and(verified) translates to MIN(verified), item
 * ids are synthetic (aggregation key is box + part). The web's verification_tasks /
 * scheduleCycleCount cycle-count machinery is deliberately absent on Android — boxes
 * are listed directly and a scan's verified flag is set only by goods-verify
 * (same choice as PutAwayRepository.assignScanToBox). Threading matches the other
 * repositories: suspend entry points wrap plain blocking Room calls in
 * withContext(Dispatchers.IO).
 */
class GoodsVerifyRepository(private val db: AppDatabase) {

    private val dao get() = db.goodsVerifyDao()

    /** All shelves with box counts, ordered by code (web goods-verify index page). */
    suspend fun listShelves(): List<ShelfSummary> = withContext(Dispatchers.IO) {
        dao.shelfSummaries().map { ShelfSummary(it.code, it.zone, it.boxCount) }
    }

    /**
     * Boxes on one shelf, newest first (web goods-verify shelf page). checkedToday is
     * web parity (lastCheckAt on the current date), computed on the UTC date.
     */
    suspend fun listBoxes(shelfCode: String): List<VerifyBoxSummary> = withContext(Dispatchers.IO) {
        val today = LocalDate.now(ZoneOffset.UTC)
        dao.boxSummaries(shelfCode).map { row ->
            VerifyBoxSummary(
                id = row.id, status = row.status,
                itemCount = row.itemCount, verifiedCount = row.verifiedCount,
                lastCheckAt = row.lastCheckAt,
                checkedToday = row.lastCheckAt?.let {
                    Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() == today
                } ?: false,
            )
        }
    }

    /** Box detail: header (null → box not found) + per-part items ordered by part_no. */
    suspend fun getBoxDetail(boxId: String): VerifyBoxDetail? = withContext(Dispatchers.IO) {
        val header = dao.boxHeader(boxId) ?: return@withContext null
        VerifyBoxDetail(
            id = header.id, status = header.status,
            shelfCode = header.shelfCode, shelfZone = header.shelfZone,
            items = dao.boxItems(boxId).map {
                VerifyBoxItem(it.partId, it.partNo, it.description, it.qty, it.allVerified == 1, it.verifiedAt)
            },
        )
    }
}
