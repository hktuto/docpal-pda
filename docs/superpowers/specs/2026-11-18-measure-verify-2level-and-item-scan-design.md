# Measuring / Verify 2-level navigation + single-item box quick scan

Date: 2026-11-18
Status: implemented

## Problem

1. The PDA measuring (`/measuring`) and verify (`/verify`) list pages are flat lists with an
   order-group heading. Operators want real 2-level navigation: **level 1 = picking orders,
   level 2 = the boxes of that order**.
2. Picking scan supports per-item-into-box packing. On the new level-2 box page, scanning an
   **item** should find the box whose remaining re-scan work is exactly that single item and
   auto-credit it ("mark that box as scanned") — but only when the box requires no other
   matching (label-mode packages / carton label).

## Design

### 2-level navigation (client-only)

- `/measuring` renders one row per picking order (from the existing
  `GET /measuring-boxes` groups — no backend change) and navigates to
  `/measuring/order/<orderId>`.
- `/measuring/order/[orderId].vue` renders that group's box rows
  (→ `/measuring/<boxId>` as today) plus a back affordance.
- `/verify` derives distinct order numbers from the pending `VerifyTaskListRow.orderNos`
  (a cross-order task appears under each of its orders) and navigates to
  `/verify/order/<orderNo>`; `/verify/order/[orderNo].vue` filters the tasks whose
  `orderNos` include that order. Box-id scanning on the old lists keeps working
  (exact → unique substring across all visible boxes).

### Quick item scan on the box page

New endpoint `POST /measuring-boxes/scan-item`:

```
{ mode: "measuring" | "verify", orderKey: string,   // orderId (measuring) / orderNo (verify)
  partNo?: string, wclItemNo?: string }             // decoded identity (client /scan/decode)
→ 200 { boxId, creditedPackages, taskCompleted }
→ 404 scan_item_no_match
```

Server-side matching (`scanItemCompleteBox` in `apps/backend/src/db/measuring.ts`):

1. Candidate boxes: measuring mode = the open boxes of `listMeasuringBoxes` group
   `orderId`; verify mode = pending `verify_tasks` whose orders include `orderNo`.
2. A box is **eligible** when:
   - it has ≥ 1 remaining (not fully re-scanned) package,
   - no remaining package is `labelMode` (printed-label requirement),
   - the box is not carton-gated (`cartonLabelRequired` → must already be verified),
   - **all** remaining packages share one part identity ("single item" box), and
   - the scanned identity (`partNo`/`wclItemNo`, `normalizePartNo` compare, falling back to
     substring containment) matches that part identity.
3. Exactly one eligible box → each remaining package is credited fully via the existing
   `verifyPackage` (open box = measuring pass; closed/tasked box = verify pass — same
   branching, ledger rows included).
4. Verify mode only: after crediting, `completeVerifyTask` is attempted for the box's
   pending task; a 409 (label/carton gate, etc.) is swallowed and reported as
   `taskCompleted: false` — the box stays credited but still needs the normal flow.

Batch fields are not re-validated server-side for this fast path — by construction the box
is single-part and label-mode-free, matching the user requirement "only when no other
matching like labeling is required".

### Client flow on the level-2 page

`onScan`: try box-id match first (existing behaviour); otherwise decode the raw via
`POST /scan/decode` and call `POST /measuring-boxes/scan-item` with the parsed identity
(`itemId`/`wclItemNo`; the raw string itself when decode is unmatched). Success → toast +
reload; no match → toast.
