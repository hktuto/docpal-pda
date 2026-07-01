import { ref } from "vue";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import type {
  OcrParseResult,
  ReceivingCandidate,
  PickingCandidate,
} from "~/db/ocrPicking";
import {
  findReceivingCandidates,
  findPickingCandidates,
  applyOcrPick,
} from "~/db/ocrPicking";

export type MatchResult =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "no_match"; reason: string }
  | { status: "single"; receiving: ReceivingCandidate; picking: PickingCandidate }
  | { status: "multiple"; receiving: ReceivingCandidate; picking: PickingCandidate[] }
  | { status: "applying" }
  | { status: "success"; pickingOrderRefNo: string; qty: number }
  | { status: "error"; message: string };

export function useOcrPicking() {
  const matchResult = ref<MatchResult>({ status: "idle" });
  const scannedQty = ref<number>(0);

  async function match(
    db: PgliteDatabase<typeof schema>,
    receivingOrderId: string,
    parsed: OcrParseResult
  ) {
    if (
      matchResult.value.status === "scanning" ||
      matchResult.value.status === "applying"
    ) {
      return;
    }

    scannedQty.value = parsed.qty;
    matchResult.value = { status: "scanning" };

    try {
      const receivingCandidates = await findReceivingCandidates(
        db,
        receivingOrderId,
        parsed
      );

      if (receivingCandidates.length === 0) {
        matchResult.value = {
          status: "no_match",
          reason: "No matching stock in receiving area.",
        };
        return;
      }

      const receiving = receivingCandidates[0];

      if (parsed.qty > receiving.availableQty) {
        matchResult.value = {
          status: "no_match",
          reason: "Quantity exceeds available stock.",
        };
        return;
      }

      const pickingCandidates = await findPickingCandidates(
        db,
        receivingOrderId,
        receiving.partId,
        parsed.qty
      );

      if (pickingCandidates.length === 0) {
        matchResult.value = {
          status: "no_match",
          reason: "No linked picking order needs this item.",
        };
        return;
      }

      if (pickingCandidates.length === 1) {
        matchResult.value = {
          status: "single",
          receiving,
          picking: pickingCandidates[0],
        };
        return;
      }

      matchResult.value = {
        status: "multiple",
        receiving,
        picking: pickingCandidates,
      };
    } catch (e: any) {
      matchResult.value = {
        status: "error",
        message: e?.message ?? "Failed to match label",
      };
    }
  }

  async function apply(
    db: PgliteDatabase<typeof schema>,
    receiving: ReceivingCandidate,
    picking: PickingCandidate,
    actorId: string
  ) {
    if (matchResult.value.status === "applying") {
      return;
    }

    matchResult.value = { status: "applying" };
    try {
      const qty = scannedQty.value;
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error("Invalid quantity to apply");
      }
      if (qty > receiving.availableQty) {
        throw new Error("Quantity no longer available in receiving");
      }
      if (qty > picking.remainingQty) {
        throw new Error("Quantity exceeds picking order need");
      }
      await applyOcrPick(
        db,
        receiving.receivingInvoiceItemId,
        picking.pickingItemId,
        qty,
        receiving.dateCode,
        receiving.lotCode,
        receiving.originCountry,
        actorId
      );
      matchResult.value = {
        status: "success",
        pickingOrderRefNo: picking.pickingOrderRefNo,
        qty,
      };
    } catch (e: any) {
      matchResult.value = {
        status: "error",
        message: e?.message ?? "Failed to apply pick",
      };
    }
  }

  function reset() {
    matchResult.value = { status: "idle" };
    scannedQty.value = 0;
  }

  return { matchResult, match, apply, reset };
}
