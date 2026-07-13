package com.docpal.warehousepda.domain

import com.docpal.warehousepda.data.db.AppDatabase
import com.docpal.warehousepda.data.db.TransitionLogEntity
import com.docpal.warehousepda.domain.model.ShelfSummary
import com.docpal.warehousepda.domain.model.VerifyBoxDetail
import com.docpal.warehousepda.domain.model.VerifyBoxItem
import com.docpal.warehousepda.domain.model.VerifyBoxSummary
import com.docpal.warehousepda.ui.goodsverify.GoodsVerifyShelfListSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID

/**
 * Goods-verify read model: shelf list → boxes on shelf → box detail, plus the two
 * mutations verifyBoxItem / markBoxVerified. Port of the web pglite queries and
 * mutations (apps/web/db/goodsVerify.ts): bool_and(verified) translates to
 * MIN(verified), item ids are synthetic (aggregation key is box + part). The web's
 * verification_tasks / scheduleCycleCount cycle-count machinery is deliberately
 * absent on Android — boxes are listed directly and a scan's verified flag is set
 * only by goods-verify (same choice as PutAwayRepository.assignScanToBox).
 *
 * Two API divergences are deliberately NOT ported (pglite parity instead):
 * - the API's verified=0-only update with its 404 (apps/api/src/db/putAway.ts:243-254)
 *   — pglite verifyShelfBoxScans rewrites verified/verified_at on every matching
 *   scan row and throws shelf_box_item_not_found when nothing matched;
 * - the API's closed-status requirement for mark-verified
 *   (apps/api/src/db/measure.ts:162) — pglite markShelfBoxVerified allows open boxes.
 *
 * Threading matches the other repositories: suspend entry points wrap plain
 * blocking Room calls in withContext(Dispatchers.IO); mutations self-wrap
 * db.runInTransaction.
 */
class GoodsVerifyRepository(private val db: AppDatabase) : GoodsVerifyShelfListSource {

    private val dao get() = db.goodsVerifyDao()

    /** All shelves with box counts, ordered by code (web goods-verify index page). */
    override suspend fun listShelves(): List<ShelfSummary> = withContext(Dispatchers.IO) {
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

    /** pglite verifyShelfBoxScans: verifies every scan of the part in the box; no status check, no log. */
    suspend fun verifyBoxItem(boxId: String, partId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val changed = dao.verifyScansInBoxForPart(boxId, partId, System.currentTimeMillis())
            if (changed == 0) throw LocalizedException("shelf_box_item_not_found")
        }
    }

    /** pglite markShelfBoxVerified: not-found → already-verified → no-items → not-all-verified; logs closed|open → verified. */
    suspend fun markBoxVerified(boxId: String, actorId: String) = withContext(Dispatchers.IO) {
        db.runInTransaction {
            val header = dao.boxHeader(boxId) ?: throw LocalizedException("shelf_box_not_found")
            if (header.status == "verified") throw LocalizedException("shelf_box_already_verified")
            if (dao.scanCount(boxId) == 0) throw LocalizedException("shelf_box_has_no_items")
            if (dao.unverifiedScanCount(boxId) > 0) throw LocalizedException("not_all_shelf_box_items_verified")
            dao.updateBoxStatus(boxId, "verified")
            dao.insertTransitionLog(
                TransitionLogEntity(
                    id = UUID.randomUUID().toString(),
                    entityType = "shelf_box",
                    entityId = boxId,
                    fromState = header.status,
                    toState = "verified",
                    actorId = actorId,
                    metadata = null,
                    createdAt = System.currentTimeMillis(),
                )
            )
        }
    }
}
