import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  assertCanApplyMismatchQty,
  computeReceivedQty,
  validateMismatchInputs,
  type MismatchReason,
} from "@warehouse/shared";
import { type DbOrTx, queryGet, queryRun } from "./query.js";
import { logTransition } from "../ingest/transition.js";

// Mismatch tracking is inline on receiving_invoice_items (reported_mismatch + mismatch_*):
// one active mismatch per item, no lifecycle (no confirm step, no statuses). Report and edit
// apply the effective received qty immediately; cancel restores received_qty = qty (the
// document expected qty — documented approximation: previous_received_qty no longer exists
// anywhere, and the realistic case is "report was a mistake, goods match the packing list").
// Validation comes from @warehouse/shared; failures map to HTTPException
// (400 validation / 404 missing / 409 state), messages keep the web's i18n-key style.

export interface MismatchRow {
  receiving_invoice_item_id: string;
  reason: string | null;
  mismatch_qty: number | null;
  wrong_part_no: string | null;
  note: string | null;
  effective_received_qty: number;
  reported: boolean;
}

interface ItemRow {
  id: string;
  qty: number;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  reportedMismatch: boolean;
  mismatchReason: string | null;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  mismatchNote: string | null;
}

async function loadItem(tx: DbOrTx, itemId: string): Promise<ItemRow> {
  const item = await queryGet<ItemRow>(
    tx,
    sql`SELECT id, qty, received_qty AS "receivedQty", picked_qty AS "pickedQty", put_away_qty AS "putAwayQty",
               reported_mismatch AS "reportedMismatch", mismatch_reason AS "mismatchReason",
               mismatch_qty AS "mismatchQty", wrong_part_no AS "wrongPartNo", mismatch_note AS "mismatchNote"
        FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
  return item;
}

function toRow(item: ItemRow): MismatchRow {
  return {
    receiving_invoice_item_id: item.id,
    reason: item.mismatchReason,
    mismatch_qty: item.mismatchQty,
    wrong_part_no: item.wrongPartNo,
    note: item.mismatchNote,
    effective_received_qty: item.receivedQty,
    reported: item.reportedMismatch,
  };
}

function badRequest(e: unknown): never {
  throw new HTTPException(400, { message: e instanceof Error ? e.message : "invalid_mismatch" });
}

/** Shared assertCanApplyMismatchQty: effective received qty must cover already-consumed stock. */
async function assertCanApply(tx: DbOrTx, item: ItemRow, effectiveReceivedQty: number): Promise<void> {
  const alloc = await queryGet<{ s: number }>(
    tx,
    sql`SELECT COALESCE(SUM(qty)::int, 0) AS s FROM allocations WHERE receiving_invoice_item_id = ${item.id}`
  );
  try {
    assertCanApplyMismatchQty({
      effectiveReceivedQty,
      pickedQty: item.pickedQty,
      putAwayQty: item.putAwayQty,
      allocatedQty: alloc?.s ?? 0,
    });
  } catch (e) {
    throw new HTTPException(409, { message: e instanceof Error ? e.message : "mismatch_qty_below_consumed_stock" });
  }
}

/** The active mismatch for an item (inline fields), or null when none is reported. */
export async function getMismatch(tx: DbOrTx, receivingInvoiceItemId: string): Promise<MismatchRow | null> {
  const item = await queryGet<ItemRow>(
    tx,
    sql`SELECT id, qty, received_qty AS "receivedQty", picked_qty AS "pickedQty", put_away_qty AS "putAwayQty",
               reported_mismatch AS "reportedMismatch", mismatch_reason AS "mismatchReason",
               mismatch_qty AS "mismatchQty", wrong_part_no AS "wrongPartNo", mismatch_note AS "mismatchNote"
        FROM receiving_invoice_items WHERE id = ${receivingInvoiceItemId}`
  );
  if (!item || !item.reportedMismatch) return null;
  return toRow(item);
}

export async function reportMismatch(
  tx: DbOrTx,
  a: {
    receivingInvoiceItemId: string;
    reason: MismatchReason;
    mismatchQty: number | null;
    wrongPartNo?: string | null;
    note?: string | null;
    actorId: string;
  }
): Promise<MismatchRow> {
  const wrongPartNo = a.wrongPartNo?.trim() || null;
  const note = a.note?.trim() || null;

  const item = await loadItem(tx, a.receivingInvoiceItemId);
  if (item.reportedMismatch) throw new HTTPException(409, { message: "mismatch_already_reported" });

  let effectiveReceivedQty: number;
  try {
    validateMismatchInputs({ expectedQty: item.qty, reason: a.reason, mismatchQty: a.mismatchQty, wrongPartNo });
    effectiveReceivedQty = computeReceivedQty(a.reason, item.qty, a.mismatchQty);
  } catch (e) {
    badRequest(e);
  }
  await assertCanApply(tx, item, effectiveReceivedQty);

  await queryRun(
    tx,
    sql`UPDATE receiving_invoice_items SET
      received_qty = ${effectiveReceivedQty},
      reported_mismatch = true,
      mismatch_reason = ${a.reason},
      mismatch_qty = ${a.reason !== "not_found" ? a.mismatchQty : null},
      wrong_part_no = ${a.reason === "wrong_part" ? wrongPartNo : null},
      mismatch_note = ${note}
    WHERE id = ${item.id}`
  );
  await logTransition(tx, {
    entityType: "receiving_invoice_item",
    entityId: item.id,
    fromState: null,
    toState: "mismatch_reported",
    actorId: a.actorId,
    metadata: {
      reason: a.reason,
      mismatchQty: a.mismatchQty,
      wrongPartNo,
      note,
      previousReceivedQty: item.receivedQty,
      effectiveReceivedQty,
    },
  });
  return toRow(await loadItem(tx, item.id));
}

export async function editMismatch(
  tx: DbOrTx,
  a: {
    receivingInvoiceItemId: string;
    actorId: string;
    reason?: MismatchReason;
    mismatchQty?: number | null;
    wrongPartNo?: string | null;
    note?: string | null;
  }
): Promise<MismatchRow> {
  const item = await loadItem(tx, a.receivingInvoiceItemId);
  if (!item.reportedMismatch) throw new HTTPException(409, { message: "no_mismatch_reported" });

  const reason = (a.reason ?? item.mismatchReason) as MismatchReason;
  const mismatchQty = a.mismatchQty !== undefined ? a.mismatchQty : item.mismatchQty;
  const wrongPartNo = a.wrongPartNo !== undefined ? a.wrongPartNo?.trim() || null : item.wrongPartNo;
  const note = a.note !== undefined ? a.note?.trim() || null : item.mismatchNote;

  let effectiveReceivedQty: number;
  try {
    validateMismatchInputs({ expectedQty: item.qty, reason, mismatchQty, wrongPartNo });
    effectiveReceivedQty = computeReceivedQty(reason, item.qty, mismatchQty);
  } catch (e) {
    badRequest(e);
  }
  await assertCanApply(tx, item, effectiveReceivedQty);

  await queryRun(
    tx,
    sql`UPDATE receiving_invoice_items SET
      received_qty = ${effectiveReceivedQty},
      mismatch_reason = ${reason},
      mismatch_qty = ${reason !== "not_found" ? mismatchQty : null},
      wrong_part_no = ${reason === "wrong_part" ? wrongPartNo : null},
      mismatch_note = ${note}
    WHERE id = ${item.id}`
  );
  await logTransition(tx, {
    entityType: "receiving_invoice_item",
    entityId: item.id,
    fromState: "mismatch_reported",
    toState: "mismatch_updated",
    actorId: a.actorId,
    metadata: {
      reason,
      mismatchQty,
      wrongPartNo,
      note,
      previousReceivedQty: item.receivedQty,
      effectiveReceivedQty,
    },
  });
  return toRow(await loadItem(tx, item.id));
}

export async function cancelMismatch(
  tx: DbOrTx,
  a: { receivingInvoiceItemId: string; actorId: string }
): Promise<MismatchRow> {
  const item = await loadItem(tx, a.receivingInvoiceItemId);
  if (!item.reportedMismatch) throw new HTTPException(409, { message: "no_mismatch_reported" });

  // Restores received_qty = qty (document expected qty) — see the module comment.
  // No assertCanApply: qty >= any effective qty >= consumed, so the restore is always safe.
  await queryRun(
    tx,
    sql`UPDATE receiving_invoice_items SET
      received_qty = qty,
      reported_mismatch = false,
      mismatch_reason = NULL,
      mismatch_qty = NULL,
      wrong_part_no = NULL,
      mismatch_note = NULL
    WHERE id = ${item.id}`
  );
  await logTransition(tx, {
    entityType: "receiving_invoice_item",
    entityId: item.id,
    fromState: "mismatch_reported",
    toState: "mismatch_cancelled",
    actorId: a.actorId,
    metadata: { restoredReceivedQty: item.qty },
  });
  return toRow(await loadItem(tx, item.id));
}
