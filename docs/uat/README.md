# UAT tracking — how it works

Source of truth (all agent- and git-friendly), one xlsx generated from them:

- `functions.json` — one array, the 62 admin/PDA functions. Stable ids `ADM-`/`PDA-`; bugs/features reference them. **Never renumber** an id; add new functions at the end.
- `bugs/BUG-<id>.json` — **one file per bug** (so the list never becomes one huge array to edit).
- `features/CR-<id>.json` — one file per additional-feature request.
- `UAT-Test-Tracking.xlsx` — **generated** (gitignored): three sheets, per-function bug/feature count formulas, dropdown vocabularies. Never hand-edit as the master.

## Adding a bug or feature

1. Find the next id: `ls docs/uat/bugs | sort | tail -1` (e.g. `BUG-039.json` → new is `BUG-040`).
2. Create the file, copy the shape of a neighbour:

```json
{
 "id": "BUG-040",
 "dateFound": "2026-11-06",
 "functionId": "PDA-014",
 "description": "what broke, one line",
 "reproSteps": "",
 "severity": "Major",
 "status": "Open",
 "retestResult": "",
 "owner": "dev",
 "closedDate": "",
 "tester": "",
 "remarks": "Fixed in commit <hash> — <cause>; retest in UAT"
}
```

## Updating status

Edit that one small file (`status`, `retestResult`, `closedDate`). Nothing else references it.

## Regenerate the workbook

```bash
node scripts/gen-uat-xlsx.mjs   # after editing docs/uat/*.json
```

The script fails on: a `functionId` that doesn't exist, or two records sharing an `id` (append conflicts — renumber the newer file). Rows sort into the sheet by date.

⚠️ Regeneration **overwrites** the xlsx — if testers marked up their copy, fold those edits back into the JSON files before rerunning.

Field/vocabulary reference: bug `severity` = Critical/Major/Minor/Cosmetic; bug `status` = Open/Fixing/Ready for retest/Closed/Won't fix; `retestResult` = Passed/Failed; feature `app` = Admin/PDA/Both/Backend, `priority` = Must have/Should have/Could have, `status` = New/Agreed/In progress/Delivered/Rejected; function `result` = Not tested/Pass/Pass with notes/Fail/Blocked/N/A. Dates are `YYYY-MM-DD`.

The Oct–Nov backfilled rows carry `Backfill — commit <hash>` in remarks; trace with `git show <hash>`. New rows should cite the fixing commit or spec doc the same way.
