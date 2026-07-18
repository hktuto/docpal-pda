# Goods Verify Overview

Goods Verify is the daily count check: at the end of the day, every inventory
lot that moved (was received, put away, picked, or adjusted) gets a verify
task, and an operator confirms the physical count for each one.

## When to use it

Use the Goods Verify flow once per day (or after a busy period) to confirm
that the lots which actually moved still hold the quantities the system
expects.

## Concept

1. The operator opens the Goods Verify queue and taps **Generate today's
   tasks**. The backend creates one pending task per lot that moved today
   (running it again creates no duplicates).
   ![Goods verify list](./assets/goods-verify-list.png)
2. The queue lists the tasks — part number, shelf/box, and expected
   quantity — filterable by date and status.
3. The operator opens a task, reviews the lot's batch and location details,
   and physically counts the stock.
   ![Goods verify shelf detail](./assets/goods-verify-shelf.png)
4. If the count matches, the operator simply verifies the task. If it
   differs, the operator enters the counted quantity — the app warns that
   the lot will be corrected with an ADJUST ledger entry.
5. The task flips to `verified`; the queue shows who verified it and when.

## Related guides

- [Step-by-step operator guide](./steps.md)
- [AI scope](./ai-scope.md)
