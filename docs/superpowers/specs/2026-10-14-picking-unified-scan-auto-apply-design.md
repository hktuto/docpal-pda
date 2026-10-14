# Picking unified page — auto-apply scans (no Confirm button)

Date: 2026-10-14
Amends: `2026-10-12-picking-unified-detail-scan-design.md`

## Problem

The unified picking order detail page queued every validated scan client-side and only sent
them to the backend when the operator tapped **Confirm** in the sticky footer. In practice the
queue is pure overhead: the operator scans a label and expects it to be recorded; the review
step duplicates what the hardware beep + per-scan toast already communicate, and forgetting to
confirm loses work (leave warning).

## Decision

The unified page **applies every scan immediately** — there is no Confirm button.

- The scan queue (`usePickingScanQueue`) becomes a **transient in-flight buffer**: each
  validated scan (label, multi-portion cross-line split, receiving carton, pick-from-box, OCR
  confirm form) still queues rows exactly as before, and a `watch(queuedCount)` on the page
  immediately drains them via the existing `session.confirm` path (per-portion
  `POST /picking-items/:id/scan`, refetch + `reresolveQueued` after each apply).
- `applyAll` is drain-safe: it loops over snapshot batches until no `queued` rows remain, so
  scans arriving mid-drain are applied by the same run, exactly once (`session.confirm` still
  no-ops while a drain runs). Backward compatible with the old scan page, whose queue is
  static during its manual confirm.
- The hardware scanner is no longer gated on `!applying` — a scan during a drain queues
  instead of being dropped.
- The `orderMatched` → `window.confirm` auto-confirm prompt is gone; a `watch(completed)`
  plays the completion cue when the queue has drained and every item is fully scanned.
  Finishing is unchanged (header **Finish picking** action / backend auto-finish).

## Undo / failure model

- **Mis-scan**: the applied package shows under the part's **Unboxed packages** with the
  existing **Remove scan** button (`POST` remove — reverses the PICK ledger, returns stock,
  reopens the allocation; 409 `package_already_in_box` / `package_already_verified` once
  boxed/verified). This replaces the old "remove from queue before confirm" review step.
- **Apply failure** (e.g. allocation rebuilt mid-drain, backend 409): the row stays in the
  part's **Pending scans** section marked failed with its error and a Remove button, and the
  page toasts `partialFail` — same as a failed confirm batch today.

## Out of scope

- The old scan page `/picking/scan/[id].vue` keeps its queue + Confirm flow (same composables,
  same i18n keys — no key removals).
- No backend/API changes.
