// Shared cross-package types. DTOs from apps/web/services/types.ts will migrate
// here in a later spec when the frontend `api` adapter is implemented.
//
// Consumed via type-only imports (e.g. `import type { HealthResponse } from
// "@warehouse/shared"`), so this package ships its TypeScript source directly
// and requires no build step for consumers in this iteration.

export interface LoginRequest { username: string; password: string; }
// Role union mirrors apps/web UserRole ("operator" | "admin"); copied locally, not imported.
export interface AuthUser { id: string; username: string; name: string; role: "operator" | "admin"; }

export interface HealthResponse {
  ok: boolean;
  db: "ok" | "error";
}

export interface ReceivingPutOrder { ref_no: string; delivery_date?: string | null; supplier_code?: string | null; }
export interface ReceivingPutItem {
  line_no: number; part_no: string; description?: string | null; qty: number;
  box_id?: string | null; date_code?: string | null; lot_code?: string | null; coo?: string | null; cow?: string | null;
}
export interface ReceivingPutInvoice { invoice_no: string; supplier_code?: string | null; items: ReceivingPutItem[]; }
export interface ReceivingPutBody { order: ReceivingPutOrder; invoices: ReceivingPutInvoice[]; }
export interface PickingPutOrder { ref_no: string; ship_to?: string | null; destination_country?: string | null; }
export interface PickingPutItem {
  line_id: string; part_no: string; qty: number;
  required_date_code?: string | null; source_shelf_code?: string | null;
}
export interface PickingPutBody { order: PickingPutOrder; items: PickingPutItem[]; }
export interface IngestUpsertResponse { id: string; external_id: string; created: boolean; changed: boolean; }
export interface ConfirmArrivalResponse { id: string; status: "in_hand"; }
export interface ScanResponse { package_ids: string[]; }
// date_code/lot_code/coo/cow come from the client's OCR parse but are informational
// only — allocation is FIFO and never filtered by them (matches the web behavior).
export interface ApplyOcrPickRequest {
  picking_item_id: string; qty: number;
  date_code?: string | null; lot_code?: string | null; coo?: string | null; cow?: string | null;
  actor_id?: string | null;
}
export interface ApiErrorBody { error: string; }

// --- Receiving-item mismatch rules -------------------------------------------------
// Ported verbatim from apps/web/db/mismatch.ts so the API and the web app share the
// exact same validation. The web throws I18nError(key); here we throw a plain Error
// whose message is the same i18n key. Reason strings and status values mirror
// apps/web/db/schema.ts (mismatchReasons / mismatchStatuses).

export const mismatchReasons = [
  "not_found",
  "damaged",
  "qty_mismatch",
  "wrong_part",
  "over_shipment",
  "quality_rejection",
] as const;
export type MismatchReason = (typeof mismatchReasons)[number];

export const mismatchStatuses = ["pending", "confirmed", "cancelled"] as const;
export type MismatchStatus = (typeof mismatchStatuses)[number];

export function computeReceivedQty(
  reason: MismatchReason,
  expectedQty: number,
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
      throw new Error("unhandled_mismatch_reason");
  }
}

export function validateMismatchInputs(input: {
  expectedQty: number;
  reason: MismatchReason | null;
  mismatchQty: number | null;
  wrongPartNo: string | null;
}): void {
  const { expectedQty, reason, mismatchQty, wrongPartNo } = input;
  if (!reason) {
    throw new Error("mismatch_reason_required");
  }

  if (reason === "not_found" && mismatchQty !== null) {
    throw new Error("not_found_mismatch_cannot_include_qty");
  }

  const qty = mismatchQty ?? 0;

  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error("quantity_must_be_non_negative_integer");
  }

  if (reason === "damaged" || reason === "quality_rejection") {
    if (qty > expectedQty) {
      throw new Error("damaged_rejected_quantity_exceeds_expected");
    }
  }

  if (reason === "over_shipment" || reason === "wrong_part") {
    if (qty <= 0) {
      throw new Error("quantity_must_be_greater_than_zero");
    }
  }

  if (reason === "wrong_part" && (!wrongPartNo || wrongPartNo.trim() === "")) {
    throw new Error("wrong_part_number_required");
  }

  if (reason === "qty_mismatch" && (mismatchQty === null || mismatchQty < 0)) {
    throw new Error("quantity_mismatch_requires_valid_received_qty");
  }

  const receivedQty = computeReceivedQty(reason, expectedQty, mismatchQty);
  if (receivedQty < 0) {
    throw new Error("computed_received_quantity_cannot_be_negative");
  }
}

/** Pure form of the web's db-backed assertCanApplyMismatchQty: the caller supplies the consumed quantities. */
export function assertCanApplyMismatchQty(input: {
  effectiveReceivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  allocatedQty: number;
}): void {
  const consumed = input.pickedQty + input.putAwayQty + input.allocatedQty;
  if (input.effectiveReceivedQty < consumed) {
    throw new Error("mismatch_qty_below_consumed_stock");
  }
}
export interface UpdateShippingBoxRequest { box_size?: string | null; net_weight_g?: number | string | null; gross_weight_g?: number | string | null; destination_country?: string | null; }
export interface VerifyPackageRequest { package_id: string; actor_id?: string | null; }
export interface CreateShelfBoxRequest { shelf_code: string; actor_id?: string | null; }
export interface RecordPutAwayScanRequest { receiving_invoice_item_id: string; qty: number; date_code?: string | null; lot_code?: string | null; coo?: string | null; cow?: string | null; }
export interface AssignScanToBoxRequest { shelf_box_id: string; actor_id?: string | null; }
export interface VerifyShelfBoxItemRequest { part_id: string; actor_id?: string | null; }
