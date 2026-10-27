// Labeling stage helpers (spec
// docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md).

import { ApiError } from "~/services/apiClient";
import { I18nError } from "~/composables/i18nError";
import type { WarehouseService } from "~/services/warehouse";

/** Where the operator goes after picking finish (once the label-print prompt
 *  closes, when it opens): the labeling detail when the order entered the
 *  labeling stage, else today's measuring-off → /verify jump, else stay. */
export function resolvePickingFinishRoute(input: {
  labelingPending: boolean;
  measuringEnabled: boolean;
  verifyEnabled: boolean;
  orderId: string;
}): string | null {
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
