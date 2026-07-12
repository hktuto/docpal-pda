package com.docpal.warehousepda.data.db

import androidx.room.Dao
import androidx.room.Query

@Dao
interface GoodsVerifyDao {

    /** Shelf list with box counts (web getShelvesWithBoxes, goodsVerify.ts): LEFT JOIN keeps zero-box shelves. */
    @Query(
        """
        SELECT s.code AS code, s.zone AS zone, COUNT(sb.id) AS boxCount
        FROM shelves s LEFT JOIN shelf_boxes sb ON sb.shelf_code = s.code
        GROUP BY s.code ORDER BY s.code
        """
    )
    fun shelfSummaries(): List<ShelfSummaryRow>

    /**
     * Box summaries for one shelf (web getShelfBoxesByShelf), newest first. Per-part
     * aggregation via correlated subqueries (SQLite has no bool_and: MIN(verified) = 1
     * means every scan of the part is verified); lastCheckAt is the max verified_at.
     */
    @Query(
        """
        SELECT sb.id AS id, sb.status AS status, sb.created_at AS createdAt,
            (SELECT COUNT(*) FROM (SELECT 1 FROM put_away_scans WHERE shelf_box_id = sb.id GROUP BY part_id)) AS itemCount,
            (SELECT COUNT(*) FROM (SELECT 1 FROM put_away_scans WHERE shelf_box_id = sb.id GROUP BY part_id HAVING MIN(verified) = 1)) AS verifiedCount,
            (SELECT MAX(verified_at) FROM put_away_scans WHERE shelf_box_id = sb.id) AS lastCheckAt
        FROM shelf_boxes sb WHERE sb.shelf_code = :shelfCode ORDER BY sb.created_at DESC
        """
    )
    fun boxSummaries(shelfCode: String): List<VerifyBoxSummaryRow>

    /** Box detail header (web getShelfBoxDetail box + shelf): null when the box does not exist. */
    @Query(
        """
        SELECT sb.id AS id, sb.status AS status, sb.shelf_code AS shelfCode, s.zone AS shelfZone
        FROM shelf_boxes sb LEFT JOIN shelves s ON s.code = sb.shelf_code
        WHERE sb.id = :boxId
        """
    )
    fun boxHeader(boxId: String): VerifyBoxHeaderRow?

    /**
     * Box detail items (web getShelfBoxDetail items): scans grouped per part —
     * SUM(qty), MIN(verified) as the bool_and port, MAX(verified_at); ordered by part_no.
     */
    @Query(
        """
        SELECT pas.part_id AS partId, p.part_no AS partNo, p.description AS description,
            SUM(pas.qty) AS qty, MIN(pas.verified) AS allVerified, MAX(pas.verified_at) AS verifiedAt
        FROM put_away_scans pas JOIN parts p ON p.id = pas.part_id
        WHERE pas.shelf_box_id = :boxId GROUP BY pas.part_id ORDER BY p.part_no
        """
    )
    fun boxItems(boxId: String): List<VerifyBoxItemRow>
}

data class ShelfSummaryRow(
    val code: String,
    val zone: String?,
    val boxCount: Int,
)

data class VerifyBoxSummaryRow(
    val id: String,
    val status: String,
    val createdAt: Long,
    val itemCount: Int,
    val verifiedCount: Int,
    val lastCheckAt: Long?,
)

data class VerifyBoxHeaderRow(
    val id: String,
    val status: String,
    val shelfCode: String?,
    val shelfZone: String?,
)

data class VerifyBoxItemRow(
    val partId: String,
    val partNo: String,
    val description: String?,
    val qty: Int,
    val allVerified: Int,
    val verifiedAt: Long?,
)
