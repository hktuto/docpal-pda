# UAT tracking — how it works

- `functions.json` / `bugs.json` / `features.json` are the **source of truth** (agent- and diff-friendly).
- `UAT-Test-Tracking.xlsx` is **generated** (gitignored): per-function bug/feature count formulas, dropdown validations, autofilters.

Workflow:

1. Edit the JSON (add a bug row with `functionId`, flip `status`, etc.) — or ask the agent.
2. `node scripts/gen-uat-xlsx.mjs`
3. Hand the xlsx to testers (open in Excel/WPS; formulas compute on open).

Field notes:

- `bugs.json.functionId` / `features.json.functionId` must match a `functions.json.id` (the generator fails on unknown ids; blank allowed for features).
- Dates are `YYYY-MM-DD` strings. IDs (`ADM-`/`PDA-`, `BUG-`, `CR-`) are stable — keep them, never renumber (bug/feature rows reference function ids).
- Status vocabularies: bugs `Open/Fixing/Ready for retest/Closed/Won't fix`; features `New/Agreed/In progress/Delivered/Rejected`; result `Not tested/Pass/Pass with notes/Fail/Blocked/N/A`.
- The Oct–Nov backfilled rows carry `Backfill — commit <hash>` in remarks; new rows can reference commits or UAT rounds the same way.

Regenerating overwrites the xlsx, so testers should report changes back into the JSON (or the agent syncs them from a marked-up copy), not hand-edit the workbook as the master.
