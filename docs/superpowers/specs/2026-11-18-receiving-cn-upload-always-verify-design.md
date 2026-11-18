# CN receiving upload — always land on the verify/edit step

Date: 2026-11-18 · App: admin · Function: ADM-023
Builds on: `2026-11-08-receiving-cn-excel-local-upload-design.md`,
`2026-11-10-receiving-cn-truck-manifest-upload-design.md`,
`2026-11-17-receiving-cn-manifest-single-order-design.md`

## Problem

Since 2026-11-17, a clean Excel decode (TE confirmation or truck manifest)
auto-creates its order(s) straight from the gate — the operator never sees
the decoded rows unless the gate flagged something. Operators asked to review
and confirm every sheet themselves: the truck manifest is a supplier document
and typos (wrong qty, wrong invoice grouping, a mis-keyed part) are cheaper
to catch on the review screen than after stock exists.

## Decision

**The step-2 verify/edit screen is the mandatory landing point for every
local Excel decode.** The gate (`gateAndAutoCreate`, renamed `gateDrafts` in
`apps/admin/pages/receiving-cn/new.vue`) no longer calls
`submitExcelDrafts()` on the clean path — it always sets `step = 2`, and
creation happens only from the step-2 Create button (`submit()` →
`submitExcelDrafts()`), exactly like the gate-issue paths already did.

- Gate grading is unchanged: ambiguous part keys + invalid-qty rows ride the
  **warning** banner (invalid-qty rows are still highlighted in the editor
  and dropped from the payload on submit), everything else lists as the
  **error** banner.
- Brand prefill from the parts master still happens before the editor opens
  (confirmation sheets only).
- The parts batch-check failure path (cannot reach `/admin/parts-lookup`)
  still jumps to step 2 so drafts are removable.
- PDF uploads are untouched (no local decode, no step 2).
- Backend contract unchanged: `POST /admin/receiving-cn/excel` gets the same
  payload from the same `cnDraftToEntry` builder; nothing auto-arrives
  server-side.

## Ceilings

- One extra click per clean upload — accepted by operators in exchange for
  the review (the 2026-11-17 auto-create-only revision is fully reversed;
  the verify step that replaced it stays for ALL decodes, not just gated
  ones).
- Multi-file uploads land on step 2 with every decoded draft listed, same as
  the gate-issue path today.

## Verification

- Manual: upload a clean TE sheet → step-2 editor opens with the decoded
  rows; Create → pending order. Upload a clean manifest → editor opens
  (brand/編號 hidden, INVOICE NO column shown); Create → one arrived order
  + put-away task. Upload a sheet with an unknown MPN → same editor with
  the error banner.
- `pnpm --filter @warehouse/admin test` — no util behavior changed; the
  page-level flow has no unit-test harness (admin tests are util-level).
