import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  assertCanApplyMismatchQty,
  computeReceivedQty,
  validateMismatchInputs,
  type MismatchReason,
} from "@warehouse/shared";
import { type DbOrTx, recomputeReceivingItem } from "./invariants.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

// Port of apps/web/db/mismatch.ts. Column names follow the API table: `kind` is the
// web's `reason`, `created_at` plays the role of the web's `reported_at`. Status values
// are the web's: pending / confirmed / cancelled. The web's I18nError keys become
// HTTPException messages (400 validation / 404 missing / 409 state).
// Not ported: the web's tryMarkReceivingOrderClear/InHand side effects (the API has no
// order auto-transition helpers; orders go in_hand only via confirm-arrival).

export interface MismatchRow {
  id: string;
  receiving_invoice_item_id: string;
  kind: string;
  mismatch_qty: number | null;
  wrong_part_no: string | null;
  note: string | null;
  status: string;
  effective_received_qty: number | null;
  previous_received_qty: number | null;
  reported_by: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  qty: number;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
}

function loadItem(tx: DbOrTx, itemId: string): ItemRow {
  const item = tx.get<ItemRow>(
    sql`SELECT id, qty, received_qty AS receivedQty, picked_qty AS pickedQty, put_away_qty AS putAwayQty
        FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
  return item;
}

function loadMismatch(tx: DbOrTx, mismatchId: string): MismatchRow {
  const mismatch = tx.get<MismatchRow>(sql`SELECT * FROM receiving_item_mismatches WHERE id = ${mismatchId}`);
  if (!mismatch) throw new HTTPException(404, { message: "receiving_item_mismatch_not_found" });
  return mismatch;
}

function badRequest(e: unknown): never {
  throw new HTTPException(400, { message: e instanceof Error ? e.message : "invalid_mismatch" });
}

/** Web's assertCanApplyMismatchQty: effective received qty must cover already-consumed stock. */
function assertCanApply(tx: DbOrTx, item: ItemRow, effectiveReceivedQty: number): void {
  const alloc = tx.get<{ s: number }>(
    sql`SELECT COALESCE(SUM(qty), 0) AS s FROM allocation_receiving_items WHERE receiving_invoice_item_id = ${item.id}`
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

function applyReceivedQty(tx: DbOrTx, itemId: string, receivedQty: number): void {
  tx.run(sql`UPDATE receiving_invoice_items SET received_qty = ${receivedQty}, updated_at = ${now()} WHERE id = ${itemId}`);
  recomputeReceivingItem(tx, itemId);
}

/** Latest non-cancelled mismatch for an item (created_at DESC, id DESC), or null. */
export function getLatestMismatch(tx: DbOrTx, receivingInvoiceItemId: string): MismatchRow | null {
  return (
    tx.get<MismatchRow>(sql`
      SELECT * FROM receiving_item_mismatches
      WHERE receiving_invoice_item_id = ${receivingInvoiceItemId} AND status != 'cancelled'
      ORDER BY created_at DESC, id DESC LIMIT 1`) ?? null
  );
}

export function reportMismatch(
  tx: DbOrTx,
  a: {
    receivingInvoiceItemId: string;
    reason: MismatchReason;
    mismatchQty: number | null;
    wrongPartNo?: string | null;
    note?: string | null;
    actorId: string;
  }
): MismatchRow {
  const wrongPartNo = a.wrongPartNo?.trim() || null;
  const note = a.note?.trim() || null;

  const item = loadItem(tx, a.receivingInvoiceItemId);
  const existing = getLatestMismatch(tx, a.receivingInvoiceItemId);
  if (existing?.status === "confirmed") throw new HTTPException(409, { message: "confirmed_mismatch_already_exists" });
  if (existing) throw new HTTPException(409, { message: "pending_mismatch_already_exists" });

  let effectiveReceivedQty: number;
  try {
    validateMismatchInputs({ expectedQty: item.qty, reason: a.reason, mismatchQty: a.mismatchQty, wrongPartNo });
    effectiveReceivedQty = computeReceivedQty(a.reason, item.qty, a.mismatchQty);
  } catch (e) {
    badRequest(e);
  }
  assertCanApply(tx, item, effectiveReceivedQty);

  const id = crypto.randomUUID();
  const t = now();
  tx.run(sql`INSERT INTO receiving_item_mismatches
    (id, receiving_invoice_item_id, kind, mismatch_qty, wrong_part_no, note, status,
     effective_received_qty, previous_received_qty, reported_by, created_at, updated_at)
    VALUES (${id}, ${a.receivingInvoiceItemId}, ${a.reason},
            ${a.reason !== "not_found" ? a.mismatchQty : null},
            ${a.reason === "wrong_part" ? wrongPartNo : null},
            ${note}, 'pending', ${effectiveReceivedQty}, ${item.receivedQty}, ${a.actorId}, ${t}, ${t})`);
  applyReceivedQty(tx, a.receivingInvoiceItemId, effectiveReceivedQty);
  logTransition(tx, {
    entityType: "receiving_item_mismatch",
    entityId: a.receivingInvoiceItemId,
    fromStatus: null,
    toStatus: "pending",
    actorId: a.actorId,
    note: JSON.stringify({ reason: a.reason, mismatchQty: a.mismatchQty, wrongPartNo, effectiveReceivedQty, note }),
  });
  return loadMismatch(tx, id);
}

export function editMismatch(
  tx: DbOrTx,
  a: {
    mismatchId: string;
    actorId: string;
    reason?: MismatchReason;
    mismatchQty?: number | null;
    wrongPartNo?: string | null;
    note?: string | null;
  }
): MismatchRow {
  const mismatch = loadMismatch(tx, a.mismatchId);
  if (mismatch.status !== "pending") throw new HTTPException(409, { message: "only_pending_mismatch_can_be_edited" });
  if (mismatch.reported_by !== a.actorId) throw new HTTPException(409, { message: "only_reporter_can_edit_mismatch" });

  const item = loadItem(tx, mismatch.receiving_invoice_item_id);
  const reason = (a.reason ?? mismatch.kind) as MismatchReason;
  const mismatchQty = a.mismatchQty !== undefined ? a.mismatchQty : mismatch.mismatch_qty;
  const wrongPartNo = a.wrongPartNo !== undefined ? a.wrongPartNo?.trim() || null : mismatch.wrong_part_no;
  const note = a.note !== undefined ? a.note?.trim() || null : mismatch.note;

  let effectiveReceivedQty: number;
  try {
    validateMismatchInputs({ expectedQty: item.qty, reason, mismatchQty, wrongPartNo });
    effectiveReceivedQty = computeReceivedQty(reason, item.qty, mismatchQty);
  } catch (e) {
    badRequest(e);
  }
  assertCanApply(tx, item, effectiveReceivedQty);

  tx.run(sql`UPDATE receiving_item_mismatches SET
      kind = ${reason},
      mismatch_qty = ${reason !== "not_found" ? mismatchQty : null},
      wrong_part_no = ${reason === "wrong_part" ? wrongPartNo : null},
      note = ${note},
      effective_received_qty = ${effectiveReceivedQty},
      updated_at = ${now()}
    WHERE id = ${a.mismatchId}`);
  applyReceivedQty(tx, mismatch.receiving_invoice_item_id, effectiveReceivedQty);
  logTransition(tx, {
    entityType: "receiving_item_mismatch",
    entityId: mismatch.receiving_invoice_item_id,
    fromStatus: "pending",
    toStatus: "pending",
    actorId: a.actorId,
    note: JSON.stringify({ reason, mismatchQty, wrongPartNo, effectiveReceivedQty, note }),
  });
  return loadMismatch(tx, a.mismatchId);
}

export function confirmMismatch(tx: DbOrTx, a: { mismatchId: string; actorId: string }): MismatchRow {
  const mismatch = loadMismatch(tx, a.mismatchId);
  if (mismatch.status !== "pending") throw new HTTPException(409, { message: "only_pending_mismatch_can_be_confirmed" });
  if (mismatch.reported_by === a.actorId) throw new HTTPException(409, { message: "reporter_cannot_confirm_own_mismatch" });

  tx.run(sql`UPDATE receiving_item_mismatches
    SET status = 'confirmed', confirmed_by = ${a.actorId}, confirmed_at = ${now()}, updated_at = ${now()}
    WHERE id = ${a.mismatchId}`);
  // received_qty was already applied at report/edit time; keep the maintained columns fresh.
  recomputeReceivingItem(tx, mismatch.receiving_invoice_item_id);
  logTransition(tx, {
    entityType: "receiving_item_mismatch",
    entityId: mismatch.receiving_invoice_item_id,
    fromStatus: "pending",
    toStatus: "confirmed",
    actorId: a.actorId,
    note: JSON.stringify({ mismatchId: a.mismatchId }),
  });
  return loadMismatch(tx, a.mismatchId);
}

export function cancelMismatch(tx: DbOrTx, a: { mismatchId: string; actorId: string }): MismatchRow {
  const mismatch = loadMismatch(tx, a.mismatchId);
  if (mismatch.status !== "pending") throw new HTTPException(409, { message: "only_pending_mismatch_can_be_cancelled" });
  if (mismatch.reported_by === a.actorId) throw new HTTPException(409, { message: "reporter_cannot_cancel_own_mismatch" });

  const item = loadItem(tx, mismatch.receiving_invoice_item_id);
  const revertTo = mismatch.previous_received_qty ?? item.receivedQty;
  assertCanApply(tx, item, revertTo);

  tx.run(sql`UPDATE receiving_item_mismatches
    SET status = 'cancelled', cancelled_by = ${a.actorId}, cancelled_at = ${now()}, updated_at = ${now()}
    WHERE id = ${a.mismatchId}`);
  applyReceivedQty(tx, mismatch.receiving_invoice_item_id, revertTo);
  logTransition(tx, {
    entityType: "receiving_item_mismatch",
    entityId: mismatch.receiving_invoice_item_id,
    fromStatus: "pending",
    toStatus: "cancelled",
    actorId: a.actorId,
    note: JSON.stringify({ mismatchId: a.mismatchId, revertedToQty: revertTo }),
  });
  return loadMismatch(tx, a.mismatchId);
}
