# CN receiving scan — part-only matching (design)

Date: 2026-11-05
Supersedes (matching half of): `2026-11-04-cn-receiving-scan-grouping-design.md`
Plan: `docs/superpowers/plans/2026-11-05-cn-receiving-part-only-scan-matching.md`

## Problem

In the customer receiving (CN) flow the invoice lines' `date_code` / `lot_code` /
`coo` / `cow` come from DocPal OCR of the uploaded PDF (written by the external
upstream-sync service). UAT feedback: these OCR batch fields are unreliable —
a wrong non-NULL `date_code` on a line plus a real scanned label date code made
`POST /receiving-cn/scan-tasks/:id/scan-aggregate` return 404 `no_matching_item`,
blocking the operator even though the physical part was correct.

Only two things from the PDF are trustworthy: the **part number** and the
**total quantity** per part.

## Decision

The scanned physical label is the source of truth for batch identity.

1. **Matching is part-number-only.** `scanCnTaskAggregate` credits any OPEN
   line whose `part_no`/`wcl_item_no` normalized-equals a label part key —
   the label/carried-line `dateCode`/`lotCode`/`coo`/`cow` no longer filter
   candidates (`lotCode` never did). A conflicting OCR batch value can no
   longer produce 404 `no_matching_item`; 404 now means "no open line with
   this part" only.
2. **Scanned batch fields overwrite the line.** When a scan credits a line,
   the label's non-undefined `dateCode`/`lotCode`/`coo`/`cow` are written to
   the line columns directly (previously `COALESCE` fill-if-NULL, which kept
   wrong OCR values alive). Different scans of the same part may credit
   different FIFO lines and stamp different batch values per line — that is
   accepted; grouping is by part, so per-line batch identity is informational.
3. **Display grouping is part-only.** `apps/pda/utils/cnScanGroups.ts` keys
   groups on the normalized part identity alone (dateCode/COO/COW dropped).
   The group's `dateCode`/`coo`/`cow` display fields show the distinct values
   across member lines (joined ` · `), or null when none.

FIFO credit order, over-scan handling, flag/reset, finalize → unchanged.

## Non-goals

- No flow-config knob: this is a defect fix for all CN warehouses, not an
  optional behavior.
- The admin item-edit endpoint (`PATCH /admin/receiving-cn/...`) still allows
  manual correction of OCR batch fields; that stays.
