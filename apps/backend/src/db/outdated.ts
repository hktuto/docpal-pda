import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { outdatedScanWarnings } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { dateCodeRank, outdatedThresholdRankMonths } from "./dateCode.js";

// ---------------------------------------------------------------------------
// Supplier outdated date-code scan warnings (spec
// docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md).
// When a picking / put-away scan's label date code (WWYY) is older than the
// supplier profile's outdated_limit_months, the scan STILL succeeds and an
// outdated_scan_warnings row is recorded inside the same transaction; order
// completion is blocked until an admin resolves the whole order's warnings —
// explicit picking finish 409s, picking auto-finish and the receiving order's
// auto-clear are held (the resolve-order route re-runs them). No profile /
// NULL limit / unparseable date code = no check (silently pass).
// ---------------------------------------------------------------------------

export type OutdatedOrderKind = "picking" | "putaway";

/** The order's SSE list topic (picking_orders / receiving_orders). */
function orderTopic(orderKind: OutdatedOrderKind): string {
  return orderKind === "picking" ? "/picking-orders" : "/receiving-orders";
}

/**
 * Is `dateCode` (WWYY, post date_code_encoding decode) older than the
 * supplier's outdated limit? Returns { limitMonths } when outdated, null when
 * the scan passes — no supplier profile, NULL limit, or an
 * unparseable/missing date code all pass silently.
 */
export async function checkOutdatedDateCode(
  db: DbOrTx,
  input: { supplierCode: string | null | undefined; dateCode: string | null | undefined; now?: Date }
): Promise<{ limitMonths: number } | null> {
  if (!input.supplierCode) return null;
  const rank = dateCodeRank(input.dateCode, input.now);
  if (rank === null) return null;
  const profile = await queryGet<{ limitMonths: number | null }>(
    db,
    sql`SELECT outdated_limit_months AS "limitMonths" FROM supplier_profiles WHERE supplier_code = ${input.supplierCode}`
  );
  if (!profile || profile.limitMonths === null) return null;
  return rank < outdatedThresholdRankMonths(profile.limitMonths, input.now) ? { limitMonths: profile.limitMonths } : null;
}

/**
 * Picking-scan variant: resolve the supplier from the part's brand
 * (parts.brand ∈ supplier_profiles.brands — the same matching the PDA's
 * brandWhitelistUnion scan-template lookup uses) and run the WWYY age check.
 * Returns the warning payload when outdated, null when the scan passes (no
 * brand-matched profile, NULL limit, or unparseable/missing date code).
 * `partNo` is the picking item's part key (parts.wcl_item_no).
 */
export async function checkPartScanOutdated(
  db: DbOrTx,
  input: { partNo: string; dateCode: string | null | undefined; now?: Date }
): Promise<(OutdatedWarningInfo & { partNo: string | null; wclItemNo: string | null }) | null> {
  const rank = dateCodeRank(input.dateCode, input.now);
  if (rank === null) return null;
  const profile = await queryGet<{ supplierCode: string; limitMonths: number; partNo: string; wclItemNo: string }>(
    db,
    sql`SELECT sp.supplier_code AS "supplierCode", sp.outdated_limit_months AS "limitMonths",
               p.part_no AS "partNo", p.wcl_item_no AS "wclItemNo"
        FROM supplier_profiles sp
        JOIN parts p ON p.wcl_item_no = ${input.partNo} AND p.brand = ANY(sp.brands)
        WHERE sp.outdated_limit_months IS NOT NULL
        ORDER BY sp.supplier_code
        LIMIT 1`
  );
  if (!profile) return null;
  if (rank >= outdatedThresholdRankMonths(profile.limitMonths, input.now)) return null;
  return {
    supplierCode: profile.supplierCode,
    dateCode: input.dateCode!,
    limitMonths: profile.limitMonths,
    partNo: profile.partNo,
    wclItemNo: profile.wclItemNo,
  };
}

export interface OutdatedWarningInfo {
  supplierCode: string;
  dateCode: string;
  limitMonths: number;
}

/** Insert the warning row + emit outdated.warning.created, inside the scan
 *  transaction (a rolled-back scan leaves no warning). */
export async function recordOutdatedWarning(
  tx: DbOrTx,
  input: {
    orderKind: OutdatedOrderKind;
    orderId: string;
    orderItemId?: string | null;
    packageId?: string | null;
    supplierCode: string;
    wclItemNo?: string | null;
    partNo?: string | null;
    dateCode: string;
    limitMonths: number;
    qty?: number | null;
    scannedBy: string;
  }
): Promise<OutdatedWarningInfo> {
  const at = now();
  const id = newId();
  await tx.insert(outdatedScanWarnings).values({
    id,
    orderKind: input.orderKind,
    orderId: input.orderId,
    orderItemId: input.orderItemId ?? null,
    packageId: input.packageId ?? null,
    supplierCode: input.supplierCode,
    wclItemNo: input.wclItemNo ?? null,
    partNo: input.partNo ?? null,
    dateCode: input.dateCode,
    limitMonths: input.limitMonths,
    qty: input.qty ?? null,
    scannedBy: input.scannedBy,
    scannedAt: at,
    createdDate: at,
    lastUpdateDate: at,
  });
  await emitEvent(tx, {
    type: "outdated.warning.created",
    topics: ["/admin/outdated-warnings", orderTopic(input.orderKind)],
    data: { id, orderKind: input.orderKind, orderId: input.orderId, supplierCode: input.supplierCode, dateCode: input.dateCode, limitMonths: input.limitMonths },
  });
  return { supplierCode: input.supplierCode, dateCode: input.dateCode, limitMonths: input.limitMonths };
}

/** Unresolved warning count for one order — the completion-block guard and
 *  the list/detail `outdatedWarningCount`. */
export async function unresolvedOutdatedWarningCount(db: DbOrTx, orderKind: OutdatedOrderKind, orderId: string): Promise<number> {
  const row = await queryGet<{ n: number }>(
    db,
    sql`SELECT COUNT(*)::int AS n FROM outdated_scan_warnings
        WHERE order_kind = ${orderKind} AND order_id = ${orderId} AND resolved_at IS NULL`
  );
  return row?.n ?? 0;
}

/** 409 for the explicit picking finish while the order has unresolved
 *  warnings; JSON body carries the count so the client can render it. */
export function unresolvedOutdatedWarningsError(count: number): HTTPException {
  return new HTTPException(409, {
    res: new Response(JSON.stringify({ error: "unresolved_outdated_warnings", count }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });
}

/**
 * Whole-order admin resolution: stamp resolved_at/resolved_by/resolution_note
 * on every unresolved row of the order (one tx) and emit
 * outdated.warning.resolved. Idempotent — a re-resolve with nothing pending
 * stamps nothing, emits no event, and returns { resolved: 0 }.
 */
export async function resolveOrderOutdatedWarnings(
  db: AppDb,
  input: { orderKind: string; orderId: string; note?: string | null; actorId: string }
): Promise<{ resolved: number }> {
  if (input.orderKind !== "picking" && input.orderKind !== "putaway") {
    throw new HTTPException(400, { message: "invalid_order_kind" });
  }
  const orderKind = input.orderKind;
  return db.transaction(async (tx) => {
    const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${input.actorId}`);
    if (!actor) throw new HTTPException(400, { message: "actor_not_found" });
    const note = input.note?.trim() || null;
    const at = now();
    const stamped = await queryAll<{ id: string }>(
      tx,
      sql`UPDATE outdated_scan_warnings
          SET resolved_at = ${at}, resolved_by = ${input.actorId}, resolution_note = ${note}, last_update_date = ${at}
          WHERE order_kind = ${orderKind} AND order_id = ${input.orderId} AND resolved_at IS NULL
          RETURNING id`
    );
    if (stamped.length > 0) {
      await emitEvent(tx, {
        type: "outdated.warning.resolved",
        topics: ["/admin/outdated-warnings", orderTopic(orderKind)],
        data: { orderKind, orderId: input.orderId, resolved: stamped.length, actorId: input.actorId },
      });
    }
    return { resolved: stamped.length };
  });
}

// ---------------------------------------------------------------------------
// Admin reads
// ---------------------------------------------------------------------------

export interface OutdatedWarningRow {
  id: string;
  orderKind: OutdatedOrderKind;
  orderId: string;
  /** picking_orders.order_no / receiving_orders.batch_no (display). */
  orderNo: string | null;
  orderItemId: string | null;
  packageId: string | null;
  supplierCode: string;
  supplierName: string | null;
  wclItemNo: string | null;
  partNo: string | null;
  dateCode: string;
  limitMonths: number;
  qty: number | null;
  scannedBy: string;
  scannedByName: string | null;
  scannedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
}

/** Admin warnings list, newest first; filters: resolved ("true"/"false" —
 *  absent = all) and orderKind. Order no / part / supplier / actor names are
 *  joined for display. */
export async function listOutdatedWarnings(
  db: AppDb,
  filters: { resolved?: boolean; orderKind?: string } = {}
): Promise<OutdatedWarningRow[]> {
  return queryAll<OutdatedWarningRow>(
    db,
    sql`SELECT
          w.id, w.order_kind AS "orderKind", w.order_id AS "orderId",
          COALESCE(po.order_no, ro.batch_no) AS "orderNo",
          w.order_item_id AS "orderItemId", w.package_id AS "packageId",
          w.supplier_code AS "supplierCode",
          COALESCE(sp.name, s.name) AS "supplierName",
          w.wcl_item_no AS "wclItemNo", w.part_no AS "partNo",
          w.date_code AS "dateCode", w.limit_months AS "limitMonths", w.qty,
          w.scanned_by AS "scannedBy", su.display_name AS "scannedByName",
          w.scanned_at AS "scannedAt",
          w.resolved_at AS "resolvedAt", w.resolved_by AS "resolvedBy",
          ru.display_name AS "resolvedByName",
          w.resolution_note AS "resolutionNote"
        FROM outdated_scan_warnings w
        LEFT JOIN picking_orders po ON w.order_kind = 'picking' AND po.id = w.order_id
        LEFT JOIN receiving_orders ro ON w.order_kind = 'putaway' AND ro.id = w.order_id
        LEFT JOIN supplier_profiles sp ON sp.supplier_code = w.supplier_code
        LEFT JOIN suppliers s ON s.code = w.supplier_code
        LEFT JOIN users su ON su.id = w.scanned_by
        LEFT JOIN users ru ON ru.id = w.resolved_by
        WHERE TRUE
        ${filters.resolved === undefined ? sql`` : filters.resolved ? sql`AND w.resolved_at IS NOT NULL` : sql`AND w.resolved_at IS NULL`}
        ${filters.orderKind ? sql`AND w.order_kind = ${filters.orderKind}` : sql``}
        ORDER BY w.scanned_at DESC, w.id`
  );
}

/** Throw the 409 when the order still has unresolved outdated warnings
 *  (explicit picking finish guard). */
export async function assertNoUnresolvedOutdatedWarnings(tx: DbOrTx, orderKind: OutdatedOrderKind, orderId: string): Promise<void> {
  const count = await unresolvedOutdatedWarningCount(tx, orderKind, orderId);
  if (count > 0) throw unresolvedOutdatedWarningsError(count);
}
