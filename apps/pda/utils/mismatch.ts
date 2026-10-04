import type { MismatchReason } from "~/services/types";
import { I18nError } from "~/composables/i18nError";

// Client-side mismatch form validation (used by ReportIssueModal). Relocated
// from the deleted db/mismatch.ts; the server re-validates on submit.

export function computeReceivedQty(
  expectedQty: number,
  reason: MismatchReason,
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
  expectedQty: number | null,
  reason: MismatchReason | null,
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

  // expectedQty null = line qty unknown upstream — the expected-bound check
  // can't apply (the server re-validates on submit anyway).
  if (expectedQty !== null && (reason === "damaged" || reason === "quality_rejection")) {
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

  if (expectedQty !== null) {
    const receivedQty = computeReceivedQty(expectedQty, reason, mismatchQty);
    if (receivedQty < 0) {
      throw new I18nError("computed_received_quantity_cannot_be_negative");
    }
  }
}
