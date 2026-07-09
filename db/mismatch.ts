import { eq, sql, inArray, and, ne, desc } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { tryMarkReceivingOrderClear, tryMarkReceivingOrderInHand } from "~/db/receiving";
import { I18nError } from "~/composables/i18nError";
import { allocationsCte } from "./helpers";

export function computeReceivedQty(
  expectedQty: number,
  reason: schema.MismatchReason,
  mismatchQty: number | null
): number {
  switch (reason) {
    case "not_found":
      return 0;
    case "damaged":
    case "quality_rejection": {
      const bad = mismatchQty ?? 0;
      return Math.max(0, expectedQty - bad);
    }
    case "qty_mismatch": {
      return mismatchQty ?? 0;
    }
    case "over_shipment": {
      return expectedQty;
    }
    case "wrong_part":
      return 0;
    default:
      throw new I18nError("unhandled_mismatch_reason", { reason });
  }
}

export function validateMismatchInputs(
  expectedQty: number,
  reason: schema.MismatchReason | null,
  mismatchQty: number | null,
  wrongPartNo: string | null
): void {
  if (!reason) {
    throw new I18nError("mismatch_reason_required");
  }

  if (reason === "not_found" && mismatchQty !== null) {
    throw new I18nError("not_found_mismatch_cannot_include_qty");
  }

  const qty = mismatchQty ?? 0;

  if (!Number.isInteger(qty) || qty < 0) {
    throw new I18nError("quantity_must_be_non_negative_integer");
  }

  if (reason === "damaged" || reason === "quality_rejection") {
    if (qty > expectedQty) {
      throw new I18nError("damaged_rejected_quantity_exceeds_expected");
    }
  }

  if (reason === "over_shipment" || reason === "wrong_part") {
    if (qty <= 0) {
      throw new I18nError("quantity_must_be_greater_than_zero");
    }
  }

  if (reason === "wrong_part" && (!wrongPartNo || wrongPartNo.trim() === "")) {
    throw new I18nError("wrong_part_number_required");
  }

  if (reason === "qty_mismatch" && (mismatchQty === null || mismatchQty < 0)) {
    throw new I18nError("quantity_mismatch_requires_valid_received_qty");
  }

  const receivedQty = computeReceivedQty(expectedQty, reason, mismatchQty);
  if (receivedQty < 0) {
    throw new I18nError("computed_received_quantity_cannot_be_negative");
  }
}

export async function assertCanApplyMismatchQty(
  dbOrTx: PgliteDatabase<typeof schema>,
  receivingInvoiceItemId: string,
  effectiveReceivedQty: number
): Promise<void> {
  const [item] = await dbOrTx
    .select({
      pickedQty: schema.receivingInvoiceItems.pickedQty,
      putAwayQty: schema.receivingInvoiceItems.putAwayQty,
    })
    .from(schema.receivingInvoiceItems)
    .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));

  if (!item) throw new I18nError("receiving_invoice_item_not_found");

  const allocatedResult = await dbOrTx.execute(sql`
    SELECT COALESCE(alloc.allocated_qty, 0) AS allocated_qty
    FROM receiving_invoice_items rii
    LEFT JOIN (${allocationsCte()}) alloc ON alloc.receiving_invoice_item_id = rii.id
    WHERE rii.id = ${receivingInvoiceItemId}
  `);
  const allocated = Number((allocatedResult.rows[0] as any)?.allocated_qty ?? 0);
  const consumed = item.pickedQty + item.putAwayQty + allocated;

  if (effectiveReceivedQty < consumed) {
    throw new I18nError("mismatch_qty_below_consumed_stock");
  }
}

export async function getActiveMismatchForItem(
  db: PgliteDatabase<typeof schema>,
  receivingInvoiceItemId: string
): Promise<typeof schema.receivingItemMismatches.$inferSelect | null> {
  const [mismatch] = await db
    .select()
    .from(schema.receivingItemMismatches)
    .where(
      and(
        eq(schema.receivingItemMismatches.receivingInvoiceItemId, receivingInvoiceItemId),
        ne(schema.receivingItemMismatches.status, "cancelled")
      )
    )
    .orderBy(desc(schema.receivingItemMismatches.reportedAt))
    .limit(1);

  return mismatch ?? null;
}

export async function getActiveMismatchesForItems(
  db: PgliteDatabase<typeof schema>,
  receivingInvoiceItemIds: string[]
): Promise<Map<string, typeof schema.receivingItemMismatches.$inferSelect>> {
  const map = new Map<string, typeof schema.receivingItemMismatches.$inferSelect>();
  if (receivingInvoiceItemIds.length === 0) return map;

  const rows = await db
    .select()
    .from(schema.receivingItemMismatches)
    .where(
      and(
        inArray(schema.receivingItemMismatches.receivingInvoiceItemId, receivingInvoiceItemIds),
        ne(schema.receivingItemMismatches.status, "cancelled")
      )
    )
    .orderBy(desc(schema.receivingItemMismatches.reportedAt));

  for (const row of rows) {
    if (!map.has(row.receivingInvoiceItemId)) {
      map.set(row.receivingInvoiceItemId, row);
    }
  }
  return map;
}

export async function reportReceivingItemMismatch(
  db: PgliteDatabase<typeof schema>,
  receivingInvoiceItemId: string,
  actorId: string,
  reason: schema.MismatchReason,
  mismatchQty: number | null,
  wrongPartNo: string | null,
  note: string
): Promise<void> {
  const trimmedWrongPartNo = wrongPartNo?.trim() || null;
  const trimmedNote = note.trim() || null;

  await db.transaction(async (tx) => {
    const item = await tx.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId),
    });
    if (!item) throw new I18nError("receiving_invoice_item_not_found");

    const existing = await getActiveMismatchForItem(tx, receivingInvoiceItemId);
    if (existing?.status === "confirmed") {
      throw new I18nError("confirmed_mismatch_already_exists");
    }
    if (existing) {
      throw new I18nError("pending_mismatch_already_exists");
    }

    validateMismatchInputs(item.qty, reason, mismatchQty, trimmedWrongPartNo);
    const effectiveReceivedQty = computeReceivedQty(item.qty, reason, mismatchQty);
    await assertCanApplyMismatchQty(tx, receivingInvoiceItemId, effectiveReceivedQty);

    const now = new Date();
    await tx.insert(schema.receivingItemMismatches).values({
      id: uuid(),
      receivingInvoiceItemId,
      reason,
      mismatchQty: reason !== "not_found" ? mismatchQty : null,
      wrongPartNo: reason === "wrong_part" ? trimmedWrongPartNo : null,
      note: trimmedNote,
      status: "pending",
      effectiveReceivedQty,
      previousReceivedQty: item.receivedQty,
      reportedBy: actorId,
      reportedAt: now,
    });

    await tx
      .update(schema.receivingInvoiceItems)
      .set({ receivedQty: effectiveReceivedQty })
      .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));

    const invoice = await tx.query.receivingInvoices.findFirst({
      where: eq(schema.receivingInvoices.id, item.receivingInvoiceId),
      columns: { receivingOrderId: true },
    });
    const receivingOrderId = invoice?.receivingOrderId;
    if (receivingOrderId) {
      await tryMarkReceivingOrderClear(tx, receivingOrderId, actorId);
      await tryMarkReceivingOrderInHand(tx, receivingOrderId, actorId);
    }

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "receiving_item_mismatch",
      entityId: receivingInvoiceItemId,
      fromState: null,
      toState: "pending",
      actorId,
      metadata: JSON.stringify({ reason, mismatchQty, wrongPartNo: trimmedWrongPartNo, effectiveReceivedQty, note: trimmedNote }),
      createdAt: now,
    });
  });
}

export async function editReceivingItemMismatch(
  db: PgliteDatabase<typeof schema>,
  mismatchId: string,
  actorId: string,
  reason: schema.MismatchReason,
  mismatchQty: number | null,
  wrongPartNo: string | null,
  note: string
): Promise<void> {
  const trimmedWrongPartNo = wrongPartNo?.trim() || null;
  const trimmedNote = note.trim() || null;

  await db.transaction(async (tx) => {
    const mismatch = await tx.query.receivingItemMismatches.findFirst({
      where: eq(schema.receivingItemMismatches.id, mismatchId),
    });
    if (!mismatch) throw new I18nError("receiving_item_mismatch_not_found");
    if (mismatch.status !== "pending") throw new I18nError("only_pending_mismatch_can_be_edited");
    if (mismatch.reportedBy !== actorId) throw new I18nError("only_reporter_can_edit_mismatch");

    const item = await tx.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, mismatch.receivingInvoiceItemId),
    });
    if (!item) throw new I18nError("receiving_invoice_item_not_found");

    validateMismatchInputs(item.qty, reason, mismatchQty, trimmedWrongPartNo);
    const effectiveReceivedQty = computeReceivedQty(item.qty, reason, mismatchQty);
    await assertCanApplyMismatchQty(tx, mismatch.receivingInvoiceItemId, effectiveReceivedQty);

    const now = new Date();
    await tx
      .update(schema.receivingItemMismatches)
      .set({
        reason,
        mismatchQty: reason !== "not_found" ? mismatchQty : null,
        wrongPartNo: reason === "wrong_part" ? trimmedWrongPartNo : null,
        note: trimmedNote,
        effectiveReceivedQty,
      })
      .where(eq(schema.receivingItemMismatches.id, mismatchId));

    await tx
      .update(schema.receivingInvoiceItems)
      .set({ receivedQty: effectiveReceivedQty })
      .where(eq(schema.receivingInvoiceItems.id, mismatch.receivingInvoiceItemId));

    const invoice = await tx.query.receivingInvoices.findFirst({
      where: eq(schema.receivingInvoices.id, item.receivingInvoiceId),
      columns: { receivingOrderId: true },
    });
    const receivingOrderId = invoice?.receivingOrderId;
    if (receivingOrderId) {
      await tryMarkReceivingOrderClear(tx, receivingOrderId, actorId);
      await tryMarkReceivingOrderInHand(tx, receivingOrderId, actorId);
    }

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "receiving_item_mismatch",
      entityId: mismatch.receivingInvoiceItemId,
      fromState: "pending",
      toState: "pending",
      actorId,
      metadata: JSON.stringify({ reason, mismatchQty, wrongPartNo: trimmedWrongPartNo, effectiveReceivedQty, note: trimmedNote }),
      createdAt: now,
    });
  });
}

export async function confirmReceivingItemMismatch(
  db: PgliteDatabase<typeof schema>,
  mismatchId: string,
  actorId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const mismatch = await tx.query.receivingItemMismatches.findFirst({
      where: eq(schema.receivingItemMismatches.id, mismatchId),
    });
    if (!mismatch) throw new I18nError("receiving_item_mismatch_not_found");
    if (mismatch.status !== "pending") throw new I18nError("only_pending_mismatch_can_be_confirmed");
    if (mismatch.reportedBy === actorId) throw new I18nError("reporter_cannot_confirm_own_mismatch");

    const now = new Date();
    await tx
      .update(schema.receivingItemMismatches)
      .set({ status: "confirmed", confirmedBy: actorId, confirmedAt: now })
      .where(eq(schema.receivingItemMismatches.id, mismatchId));

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "receiving_item_mismatch",
      entityId: mismatch.receivingInvoiceItemId,
      fromState: "pending",
      toState: "confirmed",
      actorId,
      metadata: JSON.stringify({ mismatchId }),
      createdAt: now,
    });
  });
}

export async function cancelReceivingItemMismatch(
  db: PgliteDatabase<typeof schema>,
  mismatchId: string,
  actorId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const mismatch = await tx.query.receivingItemMismatches.findFirst({
      where: eq(schema.receivingItemMismatches.id, mismatchId),
    });
    if (!mismatch) throw new I18nError("receiving_item_mismatch_not_found");
    if (mismatch.status !== "pending") throw new I18nError("only_pending_mismatch_can_be_cancelled");
    if (mismatch.reportedBy === actorId) throw new I18nError("reporter_cannot_cancel_own_mismatch");

    await assertCanApplyMismatchQty(tx, mismatch.receivingInvoiceItemId, mismatch.previousReceivedQty);

    const item = await tx.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, mismatch.receivingInvoiceItemId),
    });
    if (!item) throw new I18nError("receiving_invoice_item_not_found");

    const now = new Date();
    await tx
      .update(schema.receivingItemMismatches)
      .set({ status: "cancelled", cancelledBy: actorId, cancelledAt: now })
      .where(eq(schema.receivingItemMismatches.id, mismatchId));

    await tx
      .update(schema.receivingInvoiceItems)
      .set({ receivedQty: mismatch.previousReceivedQty })
      .where(eq(schema.receivingInvoiceItems.id, mismatch.receivingInvoiceItemId));

    const invoice = await tx.query.receivingInvoices.findFirst({
      where: eq(schema.receivingInvoices.id, item.receivingInvoiceId),
      columns: { receivingOrderId: true },
    });
    const receivingOrderId = invoice?.receivingOrderId;
    if (receivingOrderId) {
      await tryMarkReceivingOrderClear(tx, receivingOrderId, actorId);
      await tryMarkReceivingOrderInHand(tx, receivingOrderId, actorId);
    }

    await tx.insert(schema.transitionLogs).values({
      id: uuid(),
      entityType: "receiving_item_mismatch",
      entityId: mismatch.receivingInvoiceItemId,
      fromState: "pending",
      toState: "cancelled",
      actorId,
      metadata: JSON.stringify({ mismatchId, revertedToQty: mismatch.previousReceivedQty }),
      createdAt: now,
    });
  });
}
