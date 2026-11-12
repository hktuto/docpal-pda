import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db.js";
import {
  inventoryLots,
  inventoryTransactions,
  parts,
  shelves,
  subInventories,
  transactionLogs,
} from "../../db/schema/index.js";
import { newId } from "../../db/id.js";
import { now } from "../../db/now.js";
import { actorFrom } from "../../auth/middleware.js";

/**
 * POST /admin/shelves/import-inventory — per-shelf inventory Excel import
 * (spec 2026-11-13-uat-inventory-tools-design.md). The admin console decodes
 * the .xlsx client-side and posts JSON rows; each row credits a lot on the
 * partial unique key (part_no, date_code, coo, cow, shelf_code, box_id,
 * org_id, sub_inventory_code) with coo/cow/box_id NULL — an existing lot
 * merges (total_qty += qty), otherwise a new lot is inserted. Every touched
 * lot gets an ADJUST/on_hand ledger row; the whole import writes one
 * transaction_logs row. Rows with an unknown wcl_item_no are reported and
 * skipped — valid rows still commit.
 *
 * GET /org-options?shelfCode= — the (org_id, sub_inventory_code) pairs the
 * modal's single-select may offer: all org_info pairs, restricted to the
 * shelf's sub_inventory_scopes when the shelf carries them (NULL/[] =
 * unrestricted).
 */
export const shelfInventoryImportRoute = new Hono();

interface ImportRow {
  wclItemNo: string;
  dateCode: string | null;
  qty: number;
}

shelfInventoryImportRoute.get("/org-options", async (c) => {
  const shelfCode = c.req.query("shelfCode")?.trim();
  if (!shelfCode) throw new HTTPException(400, { message: "shelfCode is required" });
  const shelf = await db
    .select({ subInventoryScopes: shelves.subInventoryScopes })
    .from(shelves)
    .where(eq(shelves.code, shelfCode));
  if (!shelf.length) throw new HTTPException(404, { message: "shelf_not_found" });

  const scopes = (shelf[0].subInventoryScopes ?? []) as { orgId: number; code: string }[];
  const rows = await db
    .select({
      orgId: subInventories.orgId,
      code: subInventories.secondaryInventoryName,
      description: subInventories.subinvDescription,
    })
    .from(subInventories)
    .orderBy(subInventories.orgId, subInventories.secondaryInventoryName);
  const pairs = rows.filter(
    (r) =>
      scopes.length === 0 ||
      scopes.some((s) => s.orgId === r.orgId && s.code === r.code)
  );
  return c.json({ pairs });
});

shelfInventoryImportRoute.post("/", async (c) => {
  const body = await c.req.json<{
    shelfCode?: unknown;
    orgId?: unknown;
    subInventoryCode?: unknown;
    rows?: unknown;
  }>();
  const shelfCode = typeof body.shelfCode === "string" ? body.shelfCode.trim() : "";
  const subInventoryCode =
    typeof body.subInventoryCode === "string" ? body.subInventoryCode.trim() : "";
  const orgId = body.orgId;
  if (!shelfCode || !subInventoryCode || !Number.isInteger(orgId)) {
    throw new HTTPException(400, { message: "shelfCode, integer orgId and subInventoryCode are required" });
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    throw new HTTPException(400, { message: "rows array is required" });
  }

  const rows: ImportRow[] = [];
  for (const [i, raw] of (body.rows as Record<string, unknown>[]).entries()) {
    const wclItemNo = String(raw.wclItemNo ?? "").trim();
    const dateCodeRaw = raw.dateCode;
    const dateCode =
      dateCodeRaw === null || dateCodeRaw === undefined || String(dateCodeRaw).trim() === ""
        ? null
        : String(dateCodeRaw).trim();
    const qty = raw.qty;
    if (!wclItemNo) throw new HTTPException(400, { message: `rows[${i}].wclItemNo is required` });
    if (!Number.isInteger(qty) || (qty as number) <= 0) {
      throw new HTTPException(400, { message: `rows[${i}].qty must be a positive integer` });
    }
    rows.push({ wclItemNo, dateCode, qty: qty as number });
  }

  const actorId = actorFrom(c).id;
  const result = await db.transaction(async (tx) => {
    // Shelf + scope validation — one error for the whole request, not per-row.
    const shelf = await tx
      .select({ subInventoryScopes: shelves.subInventoryScopes })
      .from(shelves)
      .where(eq(shelves.code, shelfCode));
    if (!shelf.length) throw new HTTPException(404, { message: "shelf_not_found" });
    const scopes = (shelf[0].subInventoryScopes ?? []) as { orgId: number; code: string }[];
    if (scopes.length > 0 && !scopes.some((s) => s.orgId === orgId && s.code === subInventoryCode)) {
      throw new HTTPException(422, { message: "org_sub_inventory_outside_shelf_scope" });
    }
    const orgRow = await tx
      .select({ id: subInventories.id })
      .from(subInventories)
      .where(
        and(eq(subInventories.orgId, orgId as number), eq(subInventories.secondaryInventoryName, subInventoryCode))
      );
    if (!orgRow.length) throw new HTTPException(422, { message: "org_sub_inventory_not_found" });

    const errors: { row: number; message: string }[] = [];
    const lotCache = new Map<string, string>();
    const txnAt = now();
    let inserted = 0;
    let merged = 0;

    for (const [i, row] of rows.entries()) {
      const part = await tx
        .select({ partNo: parts.partNo, wclItemNo: parts.wclItemNo })
        .from(parts)
        .where(eq(parts.wclItemNo, row.wclItemNo));
      if (!part.length) {
        errors.push({ row: i + 1, message: `unknown wcl_item_no: ${row.wclItemNo}` });
        continue;
      }
      const { partNo, wclItemNo } = part[0];

      // Lot upsert on the partial unique key with coo/cow/box_id NULL.
      const cacheKey = `${partNo}|${row.dateCode ?? ""}`;
      let lotId = lotCache.get(cacheKey);
      let isNew = false;
      if (!lotId) {
        const existing = await tx
          .select({ id: inventoryLots.id })
          .from(inventoryLots)
          .where(
            and(
              eq(inventoryLots.partNo, partNo),
              row.dateCode === null ? isNull(inventoryLots.dateCode) : eq(inventoryLots.dateCode, row.dateCode),
              eq(inventoryLots.shelfCode, shelfCode),
              isNull(inventoryLots.boxId),
              eq(inventoryLots.orgId, orgId as number),
              eq(inventoryLots.subInventoryCode, subInventoryCode)
            )
          );
        if (existing.length) {
          lotId = existing[0].id;
        } else {
          lotId = newId();
          isNew = true;
          await tx.insert(inventoryLots).values({
            id: lotId,
            partNo,
            wclItemNo,
            dateCode: row.dateCode,
            shelfCode,
            orgId: orgId as number,
            subInventoryCode,
            totalQty: 0,
            allocatedQty: 0,
          });
        }
        lotCache.set(cacheKey, lotId);
      } else {
        isNew = false;
      }
      await tx
        .update(inventoryLots)
        .set({ totalQty: sql`${inventoryLots.totalQty} + ${row.qty}`, lastUpdateDate: now() })
        .where(eq(inventoryLots.id, lotId));
      if (isNew) inserted++;
      else merged++;

      await tx.insert(inventoryTransactions).values({
        id: newId(),
        inventoryLotId: lotId,
        partNo,
        shelfCode,
        txnType: "ADJUST",
        qtyType: "on_hand",
        qtyDelta: row.qty,
        dateCode: row.dateCode,
        referenceType: "inventory_import",
        referenceId: shelfCode,
        actorId,
        txnReason: "admin import",
        txnAt,
      });
    }

    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "inventory_import",
      entityId: shelfCode,
      fromState: null,
      toState: "imported",
      actorId,
      metadata: { inserted, merged, orgId, subInventoryCode },
    });

    return { inserted, merged, errors };
  });

  return c.json({ ok: result.errors.length === 0, ...result });
});
