import { eq, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";

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
    SELECT
      sb.id,
      sb.shelf_code,
      sb.status,
      sb.created_at,
      COUNT(sbi.id) AS item_count,
      SUM(CASE WHEN sbi.verified THEN 1 ELSE 0 END) AS verified_count,
      MAX(sbi.verified_at) AS last_check_at,
      CASE
        WHEN DATE_TRUNC('day', MAX(sbi.verified_at)) = DATE_TRUNC('day', NOW())
        THEN true ELSE false
      END AS checked_today
    FROM shelf_boxes sb
    LEFT JOIN shelf_box_items sbi ON sbi.shelf_box_id = sb.id
    WHERE sb.shelf_code = ${shelfCode}
    GROUP BY sb.id, sb.shelf_code, sb.status, sb.created_at
    ORDER BY sb.created_at DESC
  `);

  return (result.rows ?? []).map((row) => ({
    id: String(row.id),
    shelfCode: row.shelf_code as string | null,
    status: String(row.status) as (typeof schema.boxStatus)[number],
    itemCount: Number(row.item_count ?? 0),
    verifiedCount: Number(row.verified_count ?? 0),
    lastCheckAt: row.last_check_at ? new Date(String(row.last_check_at)) : null,
    checkedToday: Boolean(row.checked_today),
  }));
}

export async function getShelfBoxDetail(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string
): Promise<ShelfBoxDetail | null> {
  const result = await db.query.shelfBoxes.findFirst({
    where: eq(schema.shelfBoxes.id, shelfBoxId),
    with: {
      shelf: true,
      receivingOrder: {
        columns: {
          id: true,
          refNo: true,
        },
      },
      items: {
        with: {
          part: {
            columns: {
              id: true,
              partNo: true,
              description: true,
            },
          },
        },
      },
    },
  });

  if (!result) return null;

  const { shelf, receivingOrder, items, ...box } = result;

  return {
    ...box,
    shelf: shelf ?? null,
    receivingOrder: receivingOrder ?? null,
    items: items.map((item) => ({
      ...item,
      part: item.part ?? null,
    })),
  };
}

export async function verifyShelfBoxItem(
  db: PgliteDatabase<typeof schema>,
  shelfBoxItemId: string
): Promise<typeof schema.shelfBoxItems.$inferSelect> {
  const [updated] = await db
    .update(schema.shelfBoxItems)
    .set({ verified: true, verifiedAt: new Date() })
    .where(eq(schema.shelfBoxItems.id, shelfBoxItemId))
    .returning();

  if (!updated) throw new Error("Shelf box item not found");
  return updated;
}

export async function markShelfBoxVerified(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string,
  actorId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const box = await tx.query.shelfBoxes.findFirst({
      where: eq(schema.shelfBoxes.id, shelfBoxId),
      with: {
        items: true,
      },
    });

    if (!box) throw new Error("Shelf box not found");
    if (box.status === "verified") throw new Error("Shelf box is already verified");
    if (box.items.length === 0) throw new Error("Shelf box has no items to verify");

    const allVerified = box.items.every((item) => item.verified);
    if (!allVerified) throw new Error("Not all shelf box items are verified");

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
