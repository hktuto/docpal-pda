import { eq, sql, and } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { I18nError } from "~/composables/i18nError";

export interface ShelfWithBoxCount {
  code: string;
  zone: string | null;
  boxCount: number;
}

export interface ShelfBoxSummary {
  id: string;
  shelfCode: string | null;
  status: (typeof schema.boxStatus)[number];
  itemCount: number;
  verifiedCount: number;
  lastCheckAt: Date | null;
  checkedToday: boolean;
}

export interface ShelfBoxDetail {
  id: string;
  receivingOrderId: string | null;
  shelfCode: string | null;
  status: (typeof schema.boxStatus)[number];
  createdAt: Date;
  shelf: { code: string; zone: string | null } | null;
  receivingOrder: { id: string; refNo: string } | null;
  items: ShelfBoxItemDetail[];
}

export interface ShelfBoxItemDetail {
  id: string;
  shelfBoxId: string;
  receivingInvoiceItemId: string | null;
  partId: string;
  qty: number;
  verified: boolean;
  verifiedAt: Date | null;
  part: { id: string; partNo: string | null; description: string | null } | null;
}

export async function getShelvesWithBoxes(
  db: PgliteDatabase<typeof schema>
): Promise<ShelfWithBoxCount[]> {
  return db
    .select({
      code: schema.shelves.code,
      zone: schema.shelves.zone,
      boxCount: sql<number>`coalesce(count(${schema.shelfBoxes.id}), 0)`.mapWith(Number),
    })
    .from(schema.shelves)
    .leftJoin(schema.shelfBoxes, eq(schema.shelfBoxes.shelfCode, schema.shelves.code))
    .groupBy(schema.shelves.code, schema.shelves.zone)
    .orderBy(schema.shelves.code);
}

export async function getShelfBoxesByShelf(
  db: PgliteDatabase<typeof schema>,
  shelfCode: string
): Promise<ShelfBoxSummary[]> {
  const result = await db.execute(sql`
    WITH box_items AS (
      SELECT shelf_box_id, part_id, bool_and(verified) AS fully_verified
      FROM put_away_scans
      GROUP BY shelf_box_id, part_id
    ),
    last_checks AS (
      SELECT shelf_box_id, MAX(verified_at) AS last_check_at
      FROM put_away_scans
      GROUP BY shelf_box_id
    )
    SELECT
      sb.id,
      sb.shelf_code,
      sb.status,
      sb.created_at,
      COUNT(bi.part_id) AS item_count,
      COUNT(CASE WHEN bi.fully_verified THEN 1 END) AS verified_count,
      lc.last_check_at
    FROM shelf_boxes sb
    LEFT JOIN box_items bi ON bi.shelf_box_id = sb.id
    LEFT JOIN last_checks lc ON lc.shelf_box_id = sb.id
    WHERE sb.shelf_code = ${shelfCode}
    GROUP BY sb.id, sb.shelf_code, sb.status, sb.created_at, lc.last_check_at
    ORDER BY sb.created_at DESC
  `);

  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    shelfCode: row.shelf_code as string | null,
    status: String(row.status) as (typeof schema.boxStatus)[number],
    itemCount: Number(row.item_count ?? 0),
    verifiedCount: Number(row.verified_count ?? 0),
    lastCheckAt: row.last_check_at ? new Date(String(row.last_check_at)) : null,
    checkedToday: row.last_check_at
      ? new Date(String(row.last_check_at)).toDateString() === new Date().toDateString()
      : false,
  }));
}

export async function getShelfBoxDetail(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string
): Promise<ShelfBoxDetail | null> {
  const box = await db.query.shelfBoxes.findFirst({
    where: eq(schema.shelfBoxes.id, shelfBoxId),
    with: {
      shelf: true,
      receivingOrder: { columns: { id: true, refNo: true } },
    },
  });
  if (!box) return null;

  const itemsResult = await db.execute(sql`
    SELECT
      pas.part_id AS partId,
      p.part_no,
      p.description,
      SUM(pas.qty) AS qty,
      bool_and(pas.verified) AS verified,
      MAX(pas.verified_at) AS verifiedAt
    FROM put_away_scans pas
    JOIN parts p ON p.id = pas.part_id
    WHERE pas.shelf_box_id = ${shelfBoxId}
    GROUP BY pas.part_id, p.part_no, p.description
  `);

  const items = (itemsResult.rows ?? []).map((row) => ({
    id: `${shelfBoxId}-${row.partId}`,
    shelfBoxId,
    receivingInvoiceItemId: null,
    partId: String(row.partId),
    qty: Number(row.qty ?? 0),
    verified: Boolean(row.verified),
    verifiedAt: row.verifiedAt ? new Date(String(row.verifiedAt)) : null,
    part: {
      id: String(row.partId),
      partNo: row.part_no as string | null,
      description: row.description as string | null,
    },
  }));

  return {
    ...box,
    shelf: box.shelf ?? null,
    receivingOrder: box.receivingOrder ?? null,
    items,
  };
}

export async function verifyShelfBoxScans(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string,
  partId: string
): Promise<void> {
  const result = await db
    .update(schema.putAwayScans)
    .set({ verified: true, verifiedAt: new Date() })
    .where(
      and(
        eq(schema.putAwayScans.shelfBoxId, shelfBoxId),
        eq(schema.putAwayScans.partId, partId)
      )
    )
    .returning({ id: schema.putAwayScans.id });

  if (result.length === 0) throw new I18nError("shelf_box_item_not_found");
}

export async function markShelfBoxVerified(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string,
  actorId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const box = await tx.query.shelfBoxes.findFirst({
      where: eq(schema.shelfBoxes.id, shelfBoxId),
    });

    if (!box) throw new I18nError("shelf_box_not_found");
    if (box.status === "verified") throw new I18nError("shelf_box_already_verified");

    const scans = await tx.query.putAwayScans.findMany({
      where: eq(schema.putAwayScans.shelfBoxId, shelfBoxId),
    });
    if (scans.length === 0) throw new I18nError("shelf_box_has_no_items");
    const allVerified = scans.every((scan) => scan.verified);
    if (!allVerified) throw new I18nError("not_all_shelf_box_items_verified");

    await tx
      .update(schema.shelfBoxes)
      .set({ status: "verified" })
      .where(eq(schema.shelfBoxes.id, shelfBoxId));

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "shelf_box",
      entityId: shelfBoxId,
      fromState: box.status,
      toState: "verified",
      actorId,
      metadata: null,
      createdAt: new Date(),
    });
  });
}
