// Packaging stage helpers (spec
// docs/superpowers/specs/2026-11-10-packaging-shipping-steps-design.md).

import { ApiError } from "~/services/apiClient";
import { I18nError } from "~/composables/i18nError";

/** True when the error is the backend's 409 packaging_not_ready (the order
 *  left the queue — confirmed by someone else or by an admin override). Same
 *  convention as isLabelingNotPending: domain errors arrive as plain-text
 *  snake_case (I18nError), ApiError body/message forms accepted too. */
export function isPackagingNotReady(e: unknown): boolean {
  if (e instanceof I18nError) return e.code === "packaging_not_ready";
  if (e instanceof ApiError) {
    return (
      e.status === 409 &&
      (e.body?.error === "packaging_not_ready" ||
        e.body?.message === "packaging_not_ready" ||
        e.message === "packaging_not_ready")
    );
  }
  return false;
}
