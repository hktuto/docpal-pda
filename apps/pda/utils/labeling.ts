// Labeling stage helpers (spec
// docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md).

import { ApiError } from "~/services/apiClient";
import { I18nError } from "~/composables/i18nError";
import type { WarehouseService } from "~/services/warehouse";
import type { FinishLabelPrintingResult } from "~/services/types";

/** Where the operator goes after picking finish (once the label-print prompt
 *  closes, when it opens): the label-printing detail when the order entered
 *  the printing stage (spec 2026-11-02 — printing wins over labeling), then
 *  the labeling detail, then today's measuring-off → /verify jump, else stay. */
export function resolvePickingFinishRoute(input: {
  /** Optional — callers/tests predating the printing stage omit it. */
  labelPrintingPending?: boolean;
  labelingPending: boolean;
  measuringEnabled: boolean;
  verifyEnabled: boolean;
  orderId: string;
}): string | null {
  if (input.labelPrintingPending) return `/label-printing/${input.orderId}`;
  if (input.labelingPending) return `/labeling/${input.orderId}`;
  if (!input.measuringEnabled && input.verifyEnabled) return "/verify";
  return null;
}

/** True when the error is the backend's 409 labeling_not_pending (the stage
 *  was already cleared — by this operator earlier or by someone else). The
 *  backend reports domain errors as plain-text snake_case bodies (I18nError);
 *  an ApiError with the code in its body/message is accepted too. */
export function isLabelingNotPending(e: unknown): boolean {
  if (e instanceof I18nError) return e.code === "labeling_not_pending";
  if (e instanceof ApiError) {
    return (
      e.status === 409 &&
      (e.body?.error === "labeling_not_pending" ||
        e.body?.message === "labeling_not_pending" ||
        e.message === "labeling_not_pending")
    );
  }
  return false;
}

/** Mark labeling done; "already-done" when the stage was already cleared. */
export async function finishLabelingOrAlreadyDone(
  warehouse: Pick<WarehouseService, "finishLabeling">,
  orderId: string
): Promise<"finished" | "already-done"> {
  try {
    await warehouse.finishLabeling(orderId);
    return "finished";
  } catch (e) {
    if (isLabelingNotPending(e)) return "already-done";
    throw e;
  }
}

/** True when the error is the backend's 409 label_printing_not_pending (the
 *  stage was already cleared — by this operator earlier or by someone else),
 *  same convention as isLabelingNotPending. */
export function isLabelPrintingNotPending(e: unknown): boolean {
  if (e instanceof I18nError) return e.code === "label_printing_not_pending";
  if (e instanceof ApiError) {
    return (
      e.status === 409 &&
      (e.body?.error === "label_printing_not_pending" ||
        e.body?.message === "label_printing_not_pending" ||
        e.message === "label_printing_not_pending")
    );
  }
  return false;
}

/** Mark label printing done; "already-done" when the stage was already
 *  cleared. The result's labelingPending tells the caller whether the order
 *  moved on to the labeling queue (false on the already-done path). */
export async function finishLabelPrintingOrAlreadyDone(
  warehouse: Pick<WarehouseService, "finishLabelPrinting">,
  orderId: string
): Promise<{ outcome: "finished" | "already-done"; result: FinishLabelPrintingResult | null }> {
  try {
    const result = await warehouse.finishLabelPrinting(orderId);
    return { outcome: "finished", result };
  } catch (e) {
    if (isLabelPrintingNotPending(e)) return { outcome: "already-done", result: null };
    throw e;
  }
}
