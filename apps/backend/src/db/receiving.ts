import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { inArray, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { transactionLogs, inventoryTransactions, receivingScanLabels } from "./schema/index.js";
import { now } from "./now.js";
import { emitEvent } from "./events.js";
import { normalizePartNo, parseQrRaw } from "./scanParse.js";
import { createPutAwayTaskTx } from "./putawaytasks.js";
import { isStepEnabled, putAwayConfig, receivingSubInventoryRules, type SubInventoryRuleGroup } from "../config.js";

// ---------------------------------------------------------------------------
// Receiving flow mutations (concepts 4-5 in docs/backend/concepts.md).
// ---------------------------------------------------------------------------

export interface ConfirmArrivalResult {
  id: string;
  batchNo: string;
  status: string;
  arrivedAt: Date | null;
  arrivedBy: string | null;
  /** Items whose line_qty is NULL — received_qty left at 0, manual confirm needed. */
  needsAttentionItems: number;
}

/**
 * First-match-wins lookup of the configured confirm-arrival sub-inventory
 * rule groups (flow config receivingSubInventoryRules; spec
 * 2026-09-02-receiving-subinventory-rules-design.md). An item enters the
 * first group whose orgIds contains its org_id; the group's patterns are
 * tried in order (glob poNoPattern — "*" matches any run of characters,
 * everything else is literal; NULL po_no is matched as ""), falling back to
 * the group's default. null = no group/pattern matched and no default → the
 * item's sub_inventory_code is left unchanged.
 */
export function matchSubInventoryRule(
  orgId: number,
  poNo: string | null,
  groups: SubInventoryRuleGroup[]
): string | null {
  const po = poNo ?? "";
  for (const group of groups) {
    if (!group.orgIds.includes(orgId)) continue;
    for (const p of group.patterns) {
      if (poNoGlobTest(p.poNoPattern, po)) return p.subInventoryCode;
    }
    return group.default;
  }
  return null;
}

/** Glob match: "*" matches any run (including empty); every other character
 *  is literal. Full-string, case-sensitive (same semantics as the old
 *  startsWith prefix rule). */
export function poNoGlobTest(pattern: string, poNo: string): boolean {
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`).test(poNo);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Confirm a pending or provisionally-received receiving order as in-hand:
 *   - order: status → in_hand, arrived_at / arrived_by stamped
 *   - items: full receipt (received_qty = line_qty) + date-code fallback from
 *     the order (concept 4); for provisional orders this completes the
 *     remaining receipt on top of any scanned partials. An item with NULL
 *     line_qty (upstream omitted the expected qty) keeps its received_qty and
 *     is counted as needsAttentionItems in the response. Items are also
 *     re-stamped with sub_inventory_code per the configured
 *     receivingSubInventoryRules (org_id + po_no glob pattern) — upstream often
 *     omits it and allocation matches on the (org_id, sub_inventory_code) pair.
 *   - ledger: RECEIVE_TO_DOCK (qty_type 'dock') row per item for the applied
 *     delta, plus a transaction_logs state transition
 * The caller schedules the allocation recompute after commit (concept 5) —
 * allocation is best-effort and must never roll back a confirmed arrival.
 */
export async function confirmReceivingArrival(
  db: AppDb,
  orderId: string,
  actorId: string
): Promise<ConfirmArrivalResult> {
  return db.transaction(async (tx) => {
    const ro = await queryGet<{ id: string; batchNo: string; status: string; dateCode: string | null }>(
      tx,
      sql`SELECT id, batch_no AS "batchNo", status, date_code AS "dateCode" FROM receiving_orders WHERE id = ${orderId}`
    );
    if (!ro) throw new HTTPException(404, { message: "receiving_order_not_found" });
    if (ro.status !== "pending" && ro.status !== "provisional_received") {
      throw new HTTPException(409, { message: `cannot_confirm_arrival_from_${ro.status}` });
    }
    const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${actorId}`);
    if (!actor) throw new HTTPException(400, { message: "actor_not_found" });

    const items = await queryAll<{
      id: string;
      lineQty: number | null;
      receivedQty: number;
      partNo: string;
      ctnNo: string | null;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      orgId: number;
      poNo: string | null;
    }>(
      tx,
      sql`SELECT rii.id, rii.line_qty AS "lineQty", rii.received_qty AS "receivedQty",
                 rii.part_no AS "partNo", rii.ctn_no AS "ctnNo",
                 rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
                 rii.coo, rii.cow,
                 rii.org_id AS "orgId", rii.po_no AS "poNo"
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE ri.receiving_order_id = ${orderId}`
    );

    const at = now();
    await queryRun(
      tx,
      sql`UPDATE receiving_orders
          SET status = 'in_hand', arrived_at = ${at}, arrived_by = ${actorId}, last_update_date = ${at}
          WHERE id = ${orderId}`
    );
    // Full receipt + date-code fallback from the order for lines without one.
    // NULL line_qty (no upstream expected qty) keeps its received_qty.
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items rii
          SET received_qty = CASE WHEN rii.line_qty IS NULL THEN rii.received_qty ELSE rii.line_qty END,
              date_code = COALESCE(rii.date_code, ${ro.dateCode})
          FROM receiving_invoices ri
          WHERE rii.receiving_invoice_id = ri.id AND ri.receiving_order_id = ${orderId}`
    );

    // Sub-inventory defaulting (flow config receivingSubInventoryRules):
    // upstream often omits the item location pair, and allocation matches on
    // it — stamp sub_inventory_code per the configured rules before the
    // caller schedules the allocation recompute. Recomputes every item of
    // the order that a rule matches (rule output overwrites upstream values);
    // items matched by no rule keep their value. org_id is never rewritten.
    const subInvRules = receivingSubInventoryRules();
    if (subInvRules.length > 0) {
      const byCode = new Map<string, string[]>();
      for (const it of items) {
        const code = matchSubInventoryRule(it.orgId, it.poNo, subInvRules);
        if (code === null) continue;
        const ids = byCode.get(code);
        if (ids) ids.push(it.id);
        else byCode.set(code, [it.id]);
      }
      for (const [code, ids] of byCode) {
        await queryRun(
          tx,
          sql`UPDATE receiving_invoice_items SET sub_inventory_code = ${code} WHERE ${inArray(sql`id`, ids)}`
        );
      }
    }

    const needsAttentionItems = items.filter((it) => it.lineQty === null).length;
    const txnRows = items
      .filter((it) => it.lineQty !== null)
      .map((it) => ({ it, delta: it.lineQty! - it.receivedQty }))
      .filter(({ delta }) => delta !== 0)
      .map(({ it, delta }) => ({
        id: newId(),
        inventoryLotId: null,
        partNo: it.partNo,
        shelfCode: null,
        boxId: it.ctnNo,
        txnType: "RECEIVE_TO_DOCK",
        qtyType: "dock",
        qtyDelta: delta,
        dateCode: it.dateCode ?? ro.dateCode,
        lotCode: it.lotCode,
        coo: it.coo,
        cow: it.cow,
        referenceType: "receiving_order",
        referenceId: orderId,
        receivingInvoiceItemId: it.id,
        actorId,
        txnReason: "confirm arrival",
        txnAt: at,
      }));
    if (txnRows.length > 0) {
      await tx.insert(inventoryTransactions).values(txnRows);
    }
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "receiving_order",
      entityId: orderId,
      fromState: ro.status,
      toState: "in_hand",
      actorId,
      createdDate: at,
    });

    // Auto-create the put-away task in the same tx when the warehouse runs
    // task-based put-away (FLOW_CONFIG steps.put-away.autoCreateTasks).
    if (isStepEnabled("put-away") && putAwayConfig().autoCreateTasks) {
      await createPutAwayTaskTx(tx, { receivingOrderId: orderId, actorId });
    }

    return { id: ro.id, batchNo: ro.batchNo, status: "in_hand", arrivedAt: at, arrivedBy: actorId, needsAttentionItems };
  });
}

// ---------------------------------------------------------------------------
// Scan-based partial receipt (plan decision 1).
// ---------------------------------------------------------------------------

export interface ScanReceivingOrderInput {
  actorId: string;
  raw?: string | null;
  partNo?: string | null;
  qty?: number | null;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
  ctnNo?: string | null;
  serialNo?: string | null;
}

export interface ScanMatchCandidate {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  lineQty: number | null;
  receivedQty: number;
}

export interface ScanReceivingResult extends ScanMatchCandidate {
  ctnNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  serialNo: string | null;
}

interface ScanItemRow extends ScanReceivingResult {
  partWclItemNo: string | null;
}

/** 409 with a JSON body ({message, candidates}) — supersedes old scan-candidates. */
function matchConflict(body: { message: "no_match" | "multiple_matches"; candidates: ScanMatchCandidate[] }): HTTPException {
  return new HTTPException(409, {
    res: new Response(JSON.stringify(body), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

function toCandidate(it: ScanItemRow): ScanMatchCandidate {
  return { id: it.id, partNo: it.partNo, wclItemNo: it.wclItemNo, lineQty: it.lineQty, receivedQty: it.receivedQty };
}

/**
 * Apply one scanned receipt to an order:
 *   - parse `raw` through the order's supplier QR template (when one exists);
 *     explicit body fields override parsed ones
 *   - match the effective part number against the order's invoice items by
 *     part_no / wcl_item_no (uppercase, whitespace-collapsed)
 *   - single match: received_qty += qty (guarded at the remaining qty), order
 *     pending → provisional_received + transition log, and a RECEIVE_TO_DOCK
 *     (qty_type 'dock') ledger row with the batch snapshot
 *   - label dedup: when the effective serial (body `serialNo`, else the
 *     template's `serialNo` group) is present, a receiving_scan_labels row is
 *     inserted in the same tx; a repeat serial on this order is rejected with
 *     409 label_already_scanned (pre-check, before the qty guard so a
 *     double-scan reports the dedup error, not "qty exceeds remaining").
 *     Scans without a serial skip dedup (no row).
 *   - zero / multiple matches: 409 with the candidate list for the review dialog
 * The caller schedules the allocation recompute after commit — background, never roll back.
 */
export async function scanReceivingOrder(
  db: AppDb,
  orderId: string,
  input: ScanReceivingOrderInput
): Promise<ScanReceivingResult> {
  return db.transaction(async (tx) => {
    const ro = await queryGet<{
      id: string;
      status: string;
      dateCode: string | null;
      qrTemplate: string | null;
      qtyEncoding: string | null;
    }>(
      tx,
      sql`SELECT ro.id, ro.status, ro.date_code AS "dateCode",
                 sp.qr_template AS "qrTemplate", sp.qty_encoding AS "qtyEncoding"
          FROM receiving_orders ro
          LEFT JOIN suppliers s ON s.code = ro.supplier_code
          LEFT JOIN supplier_profiles sp ON sp.supplier_code = s.code
          WHERE ro.id = ${orderId}`
    );
    if (!ro) throw new HTTPException(404, { message: "receiving_order_not_found" });
    if (ro.status !== "pending" && ro.status !== "provisional_received") {
      throw new HTTPException(409, { message: `cannot_scan_in_status_${ro.status}` });
    }
    const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${input.actorId}`);
    if (!actor) throw new HTTPException(400, { message: "actor_not_found" });

    // Server-side parse (QR template only); explicit body fields win.
    const parsed = input.raw ? parseQrRaw(input.raw, ro.qrTemplate, ro.qtyEncoding) : {};
    const partNo = input.partNo ?? parsed.partNo ?? null;
    const qty = input.qty ?? parsed.qty ?? null;
    const serialNo = input.serialNo ?? parsed.serialNo ?? null;
    if (qty === null || !Number.isInteger(qty) || qty <= 0) {
      throw new HTTPException(400, { message: "qty_must_be_positive_integer" });
    }

    const items = await queryAll<ScanItemRow>(
      tx,
      sql`SELECT rii.id, rii.part_no AS "partNo",
                 rii.wcl_item_no AS "wclItemNo", p.wcl_item_no AS "partWclItemNo",
                 rii.line_qty AS "lineQty", rii.received_qty AS "receivedQty",
                 rii.ctn_no AS "ctnNo", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
                 rii.coo, rii.cow
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          JOIN parts p ON p.wcl_item_no = rii.wcl_item_no
          WHERE ri.receiving_order_id = ${orderId}
          ORDER BY rii.po_no, rii.po_line, rii.id`
    );

    const norm = partNo ? normalizePartNo(partNo) : null;
    const matches = norm
      ? items.filter((it) =>
          [it.partNo, it.wclItemNo, it.partWclItemNo].some((v) => v !== null && normalizePartNo(v) === norm)
        )
      : [];
    if (matches.length === 0) {
      throw matchConflict({ message: "no_match", candidates: items.map(toCandidate) });
    }
    if (matches.length > 1) {
      throw matchConflict({ message: "multiple_matches", candidates: matches.map(toCandidate) });
    }

    const item = matches[0];

    // S-key dedup pre-check: a serial already scanned on this order is a
    // double-scan of the same physical label — reject before the qty guard so
    // the operator gets the specific error (a repeat serial often also
    // exceeds the remaining qty).
    if (serialNo) {
      const dup = await queryGet<{ id: string }>(
        tx,
        sql`SELECT id FROM receiving_scan_labels
            WHERE receiving_order_id = ${orderId} AND serial_no = ${serialNo}`
      );
      if (dup) throw new HTTPException(409, { message: "label_already_scanned" });
    }

    // Over-receipt guard — skipped when the expected qty is unknown upstream
    // (NULL line_qty; the mismatch flow is the safety net for over-receipt).
    if (item.lineQty !== null && qty > item.lineQty - item.receivedQty) {
      throw new HTTPException(409, { message: "scanned_qty_exceeds_remaining" });
    }

    const at = now();
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items SET received_qty = received_qty + ${qty} WHERE id = ${item.id}`
    );
    if (ro.status === "pending") {
      await queryRun(
        tx,
        sql`UPDATE receiving_orders SET status = 'provisional_received', last_update_date = ${at} WHERE id = ${orderId}`
      );
      await tx.insert(transactionLogs).values({
        id: newId(),
        entityType: "receiving_order",
        entityId: orderId,
        fromState: "pending",
        toState: "provisional_received",
        actorId: input.actorId,
        createdDate: at,
      });
    }
    await tx.insert(inventoryTransactions).values({
      id: newId(),
      inventoryLotId: null,
      partNo: item.partNo,
      shelfCode: null,
      boxId: input.ctnNo ?? item.ctnNo,
      txnType: "RECEIVE_TO_DOCK",
      qtyType: "dock",
      qtyDelta: qty,
      dateCode: input.dateCode ?? parsed.dateCode ?? item.dateCode ?? ro.dateCode,
      lotCode: input.lotCode ?? parsed.lotCode ?? item.lotCode,
      coo: input.coo ?? parsed.coo ?? item.coo,
      cow: input.cow ?? parsed.cow ?? item.cow,
      referenceType: "receiving_order",
      referenceId: orderId,
      receivingInvoiceItemId: item.id,
      actorId: input.actorId,
      txnReason: "scan receipt",
      txnAt: at,
    });
    // Record the label for S-key dedup (only when a serial is present).
    if (serialNo) {
      await tx.insert(receivingScanLabels).values({
        id: newId(),
        receivingOrderId: orderId,
        receivingInvoiceItemId: item.id,
        serialNo,
        qty,
        scannedBy: input.actorId,
        scannedAt: at,
      });
    }

    const updated = await queryGet<Omit<ScanReceivingResult, "serialNo">>(
      tx,
      sql`SELECT rii.id, rii.part_no AS "partNo",
                 rii.wcl_item_no AS "wclItemNo", rii.line_qty AS "lineQty", rii.received_qty AS "receivedQty",
                 rii.ctn_no AS "ctnNo", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
                 rii.coo, rii.cow
          FROM receiving_invoice_items rii
          WHERE rii.id = ${item.id}`
    );
    return { ...updated!, serialNo };
  });
}

// ---------------------------------------------------------------------------
// Mismatch lifecycle on the flat receiving_invoice_items columns.
// ---------------------------------------------------------------------------

export interface MismatchInfo {
  reason: string | null;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  note: string | null;
}

export interface MismatchInput {
  actorId: string;
  reason?: string;
  mismatchQty?: number | null;
  wrongPartNo?: string | null;
  note?: string | null;
}

interface MismatchItemRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  reportedMismatch: boolean;
  mismatchReason: string | null;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  mismatchNote: string | null;
}

async function loadMismatchItem(tx: DbOrTx, itemId: string): Promise<MismatchItemRow> {
  const item = await queryGet<MismatchItemRow>(
    tx,
    sql`SELECT id, part_no AS "partNo", wcl_item_no AS "wclItemNo", po_no AS "poNo", po_line AS "poLine",
               reported_mismatch AS "reportedMismatch", mismatch_reason AS "mismatchReason",
               mismatch_qty AS "mismatchQty", wrong_part_no AS "wrongPartNo", mismatch_note AS "mismatchNote"
        FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
  return item;
}

async function assertActor(tx: DbOrTx, actorId: string): Promise<void> {
  const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${actorId}`);
  if (!actor) throw new HTTPException(400, { message: "actor_not_found" });
}

function toMismatchInfo(item: MismatchItemRow): MismatchInfo {
  return {
    reason: item.mismatchReason,
    mismatchQty: item.mismatchQty,
    wrongPartNo: item.wrongPartNo,
    note: item.mismatchNote,
  };
}

/** Item identifiers that make an item-typed log row self-describing. */
function itemMeta(item: MismatchItemRow): Record<string, unknown> {
  const m: Record<string, unknown> = { partNo: item.partNo };
  if (item.wclItemNo) m.wclItemNo = item.wclItemNo;
  if (item.poNo) m.poNo = item.poNo;
  if (item.poLine) m.poLine = item.poLine;
  return m;
}

async function logMismatch(
  tx: DbOrTx,
  item: MismatchItemRow,
  toState: string,
  actorId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await tx.insert(transactionLogs).values({
    id: newId(),
    entityType: "receiving_invoice_item",
    entityId: item.id,
    fromState: toState === "mismatch_reported" ? null : "mismatch_reported",
    toState,
    actorId,
    metadata: { ...itemMeta(item), ...metadata },
    createdDate: now(),
  });
}

/** The active mismatch for an item, or null when none is reported. */
export async function getReceivingItemMismatch(db: AppDb, itemId: string): Promise<MismatchInfo | null> {
  const item = await loadMismatchItem(db, itemId);
  return item.reportedMismatch ? toMismatchInfo(item) : null;
}

/** Report a mismatch: sets reported_mismatch + fields. 409 when already flagged. */
export async function reportReceivingItemMismatch(
  db: AppDb,
  itemId: string,
  input: MismatchInput & { reason: string }
): Promise<MismatchInfo> {
  return db.transaction(async (tx) => {
    const item = await loadMismatchItem(tx, itemId);
    await assertActor(tx, input.actorId);
    if (item.reportedMismatch) throw new HTTPException(409, { message: "mismatch_already_reported" });

    const wrongPartNo = input.wrongPartNo?.trim() || null;
    const note = input.note?.trim() || null;
    const mismatchQty = input.mismatchQty ?? null;
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items SET
            reported_mismatch = true,
            mismatch_reason = ${input.reason},
            mismatch_qty = ${mismatchQty},
            wrong_part_no = ${wrongPartNo},
            mismatch_note = ${note}
          WHERE id = ${item.id}`
    );
    await logMismatch(tx, item, "mismatch_reported", input.actorId, {
      reason: input.reason,
      mismatchQty,
      wrongPartNo,
      note,
    });
    await emitEvent(tx, {
      type: "receiving.mismatch_reported",
      topics: ["/receiving-orders"],
      data: { itemId: item.id, reason: input.reason, actorId: input.actorId },
    });
    return toMismatchInfo(await loadMismatchItem(tx, item.id));
  });
}

/** Edit the reported mismatch (absent fields stay unchanged). 404 when not flagged. */
export async function editReceivingItemMismatch(
  db: AppDb,
  itemId: string,
  input: MismatchInput
): Promise<MismatchInfo> {
  return db.transaction(async (tx) => {
    const item = await loadMismatchItem(tx, itemId);
    await assertActor(tx, input.actorId);
    if (!item.reportedMismatch) throw new HTTPException(404, { message: "mismatch_not_found" });

    const reason = input.reason !== undefined ? input.reason : item.mismatchReason;
    const mismatchQty = input.mismatchQty !== undefined ? input.mismatchQty : item.mismatchQty;
    const wrongPartNo = input.wrongPartNo !== undefined ? input.wrongPartNo?.trim() || null : item.wrongPartNo;
    const note = input.note !== undefined ? input.note?.trim() || null : item.mismatchNote;
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items SET
            mismatch_reason = ${reason},
            mismatch_qty = ${mismatchQty},
            wrong_part_no = ${wrongPartNo},
            mismatch_note = ${note}
          WHERE id = ${item.id}`
    );
    await logMismatch(tx, item, "mismatch_updated", input.actorId, { reason, mismatchQty, wrongPartNo, note });
    await emitEvent(tx, {
      type: "receiving.mismatch_updated",
      topics: ["/receiving-orders"],
      data: { itemId: item.id, actorId: input.actorId },
    });
    return toMismatchInfo(await loadMismatchItem(tx, item.id));
  });
}

/**
 * Acknowledge a reported mismatch: the flag stays set (the old confirm only
 * flipped mismatch status — no qty effect to mirror); writes a
 * 'mismatch_confirmed' transition log. 404 when not flagged.
 */
export async function confirmReceivingItemMismatch(
  db: AppDb,
  itemId: string,
  actorId: string
): Promise<MismatchInfo> {
  return db.transaction(async (tx) => {
    const item = await loadMismatchItem(tx, itemId);
    await assertActor(tx, actorId);
    if (!item.reportedMismatch) throw new HTTPException(404, { message: "mismatch_not_found" });

    await logMismatch(tx, item, "mismatch_confirmed", actorId, {
      reason: item.mismatchReason,
      mismatchQty: item.mismatchQty,
      wrongPartNo: item.wrongPartNo,
      note: item.mismatchNote,
    });
    await emitEvent(tx, {
      type: "receiving.mismatch_confirmed",
      topics: ["/receiving-orders"],
      data: { itemId: item.id, actorId },
    });
    return toMismatchInfo(item);
  });
}

/** Cancel a reported mismatch: clears the flag + nulls the fields (+ log). */
export async function cancelReceivingItemMismatch(
  db: AppDb,
  itemId: string,
  actorId: string
): Promise<null> {
  return db.transaction(async (tx) => {
    const item = await loadMismatchItem(tx, itemId);
    await assertActor(tx, actorId);
    if (!item.reportedMismatch) throw new HTTPException(404, { message: "mismatch_not_found" });

    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items SET
            reported_mismatch = false,
            mismatch_reason = NULL,
            mismatch_qty = NULL,
            wrong_part_no = NULL,
            mismatch_note = NULL
          WHERE id = ${item.id}`
    );
    await logMismatch(tx, item, "mismatch_cancelled", actorId, {});
    await emitEvent(tx, {
      type: "receiving.mismatch_cancelled",
      topics: ["/receiving-orders"],
      data: { itemId: item.id, actorId },
    });
    return null;
  });
}

export interface ReceivingMismatchRow {
  itemId: string;
  receivingOrderId: string;
  batchNo: string;
  invoiceId: string;
  invoiceNo: string;
  partNo: string;
  wclItemNo: string | null;
  supplierCode: string | null;
  reason: string | null;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  note: string | null;
}

/** Cross-order list of open mismatches (admin issues page): items with
 *  reported_mismatch = true joined to their order + invoice, newest first
 *  (items carry no timestamp, so order by the order/invoice creation). */
export async function listReceivingMismatches(db: AppDb): Promise<ReceivingMismatchRow[]> {
  return queryAll<ReceivingMismatchRow>(
    db,
    sql`SELECT rii.id AS "itemId",
               ro.id AS "receivingOrderId",
               ro.batch_no AS "batchNo",
               ri.id AS "invoiceId",
               ri.invoice_no AS "invoiceNo",
               rii.part_no AS "partNo",
               rii.wcl_item_no AS "wclItemNo",
               COALESCE(ri.supplier_code, ro.supplier_code) AS "supplierCode",
               rii.mismatch_reason AS "reason",
               rii.mismatch_qty AS "mismatchQty",
               rii.wrong_part_no AS "wrongPartNo",
               rii.mismatch_note AS "note"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        WHERE rii.reported_mismatch = true
        ORDER BY ro.created_date DESC, ri.created_date DESC, rii.id DESC`
  );
}

// --- admin audit logs + item removal (2026-07-27 design) ---------------------

export interface TransactionLogRow {
  id: string;
  entityType: string;
  entityId: string;
  fromState: string | null;
  toState: string;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdDate: Date;
}

/** Server-paging params for the order audit-log lists (same convention as
 *  the CRUD routes: page 1-based, pageSize default 50 max 200). */
export interface OrderLogsParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
}

export interface OrderLogsPage {
  rows: TransactionLogRow[];
  total: number;
}

const LOG_SORTS: Record<string, SQL> = {
  createdDate: sql`tl.created_date`,
  actorName: sql`u.display_name`,
  toState: sql`tl.to_state`,
};

/** Shared SELECT/ORDER BY helpers for the order-log queries. `where` already
 *  scopes the rows to one order; `q` adds the ILIKE search predicate. */
function logsQueryParts(params: OrderLogsParams | undefined, scope: SQL) {
  const q = params?.q?.trim();
  const like = `%${(q ?? "").replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const where = q
    ? sql`${scope} AND (u.display_name ILIKE ${like} OR tl.from_state ILIKE ${like} OR tl.to_state ILIKE ${like} OR tl.entity_type ILIKE ${like} OR tl.metadata::text ILIKE ${like})`
    : scope;
  const col = LOG_SORTS[params?.sort ?? ""] ?? LOG_SORTS.createdDate;
  const dir = params?.dir === "asc" ? sql`ASC` : sql`DESC`;
  return { where, orderBy: sql`ORDER BY ${col} ${dir} NULLS LAST, tl.id ${dir}` };
}

/** Audit trail for one receiving order: order-level rows plus the rows logged
 *  against its invoice items (mismatch report/edit/confirm/cancel), newest
 *  first by default. With `params.page` set returns `{ rows, total }`
 *  (LIMIT/OFFSET + COUNT over the same WHERE); otherwise the full array.
 *  404 when the order does not exist. */
export async function listReceivingOrderLogs(
  db: AppDb,
  orderId: string,
  params?: OrderLogsParams
): Promise<TransactionLogRow[] | OrderLogsPage> {
  const order = await queryGet<{ id: string }>(db, sql`SELECT id FROM receiving_orders WHERE id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "receiving_order_not_found" });
  const { where, orderBy } = logsQueryParts(
    params,
    sql`(tl.entity_type = 'receiving_order' AND tl.entity_id = ${orderId})
        OR (tl.entity_type = 'receiving_invoice_item' AND tl.entity_id IN (
              SELECT rii.id FROM receiving_invoice_items rii
              JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
              WHERE ri.receiving_order_id = ${orderId}))`
  );
  const from = sql`FROM transaction_logs tl LEFT JOIN users u ON u.id = tl.actor_id WHERE ${where}`;
  if (params?.page !== undefined) {
    const page = Math.max(1, params.page);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50));
    const [rows, count] = await Promise.all([
      queryAll<TransactionLogRow>(
        db,
        sql`SELECT tl.id, tl.entity_type AS "entityType", tl.entity_id AS "entityId",
                   tl.from_state AS "fromState", tl.to_state AS "toState",
                   tl.actor_id AS "actorId", u.display_name AS "actorName",
                   tl.metadata, tl.created_date AS "createdDate"
            ${from} ${orderBy} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
      ),
      queryGet<{ total: number }>(db, sql`SELECT COUNT(*)::int AS total ${from}`),
    ]);
    return { rows, total: count?.total ?? 0 };
  }
  return queryAll<TransactionLogRow>(
    db,
    sql`SELECT tl.id, tl.entity_type AS "entityType", tl.entity_id AS "entityId",
               tl.from_state AS "fromState", tl.to_state AS "toState",
               tl.actor_id AS "actorId", u.display_name AS "actorName",
               tl.metadata, tl.created_date AS "createdDate"
        ${from} ${orderBy}`
  );
}

/**
 * Admin removal of a wrong/unwanted receiving invoice item (e.g. not_found /
 * over_shipment). Blocked with 409 item_work_started once work has started on
 * the line (qty counters, allocations, shelf-box links — same guard set as the
 * ingest line removal). The item row is deleted and the audit trail survives
 * on the ORDER as an 'item_removed' transaction_logs row. If upstream re-sends
 * the order the item is re-created (same as ingest line removal).
 */
export async function deleteReceivingInvoiceItem(
  db: AppDb,
  input: { itemId: string; actorId: string }
): Promise<{ id: string; receivingOrderId: string }> {
  return db.transaction(async (tx) => {
    const item = await queryGet<{
      id: string;
      receivingOrderId: string;
      invoiceId: string;
      partNo: string;
      poNo: string | null;
      poLine: string | null;
      receivedQty: number;
      pickedQty: number;
      putAwayQty: number;
      reportedMismatch: boolean;
      allocLinks: number;
      shelfBoxLinks: number;
    }>(
      tx,
      sql`SELECT rii.id, ri.receiving_order_id AS "receivingOrderId",
                 rii.receiving_invoice_id AS "invoiceId", rii.part_no AS "partNo",
                 rii.po_no AS "poNo", rii.po_line AS "poLine",
                 rii.received_qty AS "receivedQty", rii.picked_qty AS "pickedQty",
                 rii.put_away_qty AS "putAwayQty", rii.reported_mismatch AS "reportedMismatch",
                 (SELECT COUNT(*)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id) AS "allocLinks",
                 (SELECT COUNT(*)::int FROM shelf_box_items sbi WHERE sbi.receiving_invoice_item_id = rii.id) AS "shelfBoxLinks"
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE rii.id = ${input.itemId}`
    );
    if (!item) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
    if (
      item.receivedQty > 0 ||
      item.pickedQty > 0 ||
      item.putAwayQty > 0 ||
      item.allocLinks > 0 ||
      item.shelfBoxLinks > 0
    ) {
      throw new HTTPException(409, { message: "item_work_started" });
    }

    await queryRun(tx, sql`DELETE FROM receiving_invoice_items WHERE id = ${item.id}`);
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "receiving_order",
      entityId: item.receivingOrderId,
      fromState: null,
      toState: "item_removed",
      actorId: input.actorId,
      metadata: {
        itemId: item.id,
        invoiceId: item.invoiceId,
        partNo: item.partNo,
        poNo: item.poNo,
        poLine: item.poLine,
        hadMismatch: item.reportedMismatch,
      },
      createdDate: now(),
    });
    await emitEvent(tx, {
      type: "receiving_order.item_removed",
      topics: ["/receiving-orders"],
      data: { orderId: item.receivingOrderId, itemId: item.id, actorId: input.actorId },
    });
    return { id: item.id, receivingOrderId: item.receivingOrderId };
  });
}
