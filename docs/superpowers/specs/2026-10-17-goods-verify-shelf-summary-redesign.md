# Goods-verify shelf-summary redesign

Date: 2026-10-17
Status: implemented (2026-10-17, commit a1ec7a03)

## Problem

The current goods-verify flow generates one task per inventory lot with
movement that day. The user must open each task, enter a physical count
(`countedQty`), and verify individually. This is slow and error-prone — every
item on the shelf must be re-scanned or manually counted, even when the system
already knows exactly what changed.

## Goal

Replace the per-lot verify with a **per-shelf daily summary**:

- At midnight, generate one task per shelf that had any stock movement that day.
- Each task shows the parts that changed, the net quantity delta (+/-), and the
  current expected total for each part.
- Only parts with a non-zero net delta are shown.
- The user reviews the summary on the PDA and presses a single "confirm" button
  to complete the check — no per-item scanning or counting.
- If the user finds a discrepancy, they fix it elsewhere (adjust stock, re-scan,
  etc.) — this flow is purely a confirmation of system-recorded movements.

## Current behavior (for reference)

- `goods_verify_tasks` — one row per `(task_date, inventory_lot_id)` with
  `expected_qty` snapshot, `shelf_code`, `box_id`, `part_no`.
- Generation: `generateGoodsVerifyTasks` inserts one task per distinct
  `inventory_lot_id` in `inventory_transactions` for the day.
- Verify: `verifyGoodsVerifyTask` accepts `countedQty`; if it differs from
  `expected_qty`, the lot's `total_qty` is corrected and an ADJUST ledger row
  is written.
- PDA: list page → per-task detail with countedQty input → verify button.

## Proposed design

### 1. Schema change

#### `goods_verify_tasks` table

| Column | Change |
| --- | --- |
| `inventory_lot_id` | → nullable (no longer the task key) |
| `box_id` | → nullable (kept for reference, not used for verify) |
| `expected_qty` | → nullable (replaced by per-part data in `movements`) |
| `movements` | **NEW** `jsonb` — array of changed parts (see below) |
| `part_no` | → nullable (moved into `movements` items) |

**Unique index:** drop `goods_verify_tasks_lot_day_unique` on
`(task_date, inventory_lot_id)`; add `goods_verify_tasks_shelf_day_unique` on
`(task_date, shelf_code)`.

**`movements` JSONB shape:**

```json
[
  {
    "partNo": "ABC-123",
    "wclItemNo": "WCL-456",
    "description": "Widget Assembly",
    "qtyChange": -5,
    "currentTotal": 42
  }
]
```

- `qtyChange` = net delta from `inventory_transactions` for that part on that
  shelf that day (sum of `qty_delta` where `qty_type = 'on_hand'`).
- `currentTotal` = sum of `total_qty` across all lots for that part on that
  shelf at generation time.
- Only parts with `qtyChange != 0` are included.

#### Migration

```sql
-- Drop old unique index
DROP INDEX IF EXISTS goods_verify_tasks_lot_day_unique;

-- Add new unique index
CREATE UNIQUE INDEX goods_verify_tasks_shelf_day_unique
  ON goods_verify_tasks (task_date, shelf_code);

-- Add movements column
ALTER TABLE goods_verify_tasks ADD COLUMN movements jsonb;

-- Make old columns nullable
ALTER TABLE goods_verify_tasks ALTER COLUMN inventory_lot_id DROP NOT NULL;
ALTER TABLE goods_verify_tasks ALTER COLUMN expected_qty DROP NOT NULL;
ALTER TABLE goods_verify_tasks ALTER COLUMN part_no DROP NOT NULL;
```

### 2. Generation logic (`generateGoodsVerifyTasks`)

Rewrite to aggregate by shelf:

```sql
-- For each shelf with movement that day, compute per-part net delta
SELECT
  it.shelf_code,
  it.part_no,
  p.wcl_item_no,
  p.description,
  SUM(it.qty_delta) FILTER (WHERE it.qty_type = 'on_hand') AS qty_change
FROM inventory_transactions it
JOIN parts p ON p.part_no = it.part_no
WHERE it.txn_at::date = :date
  AND it.shelf_code IS NOT NULL
  AND it.inventory_lot_id IS NOT NULL
GROUP BY it.shelf_code, it.part_no, p.wcl_item_no, p.description
HAVING SUM(it.qty_delta) FILTER (WHERE it.qty_type = 'on_hand') != 0
```

Then for each shelf, compute `currentTotal` per part:

```sql
SELECT
  il.part_no,
  SUM(il.total_qty) AS current_total
FROM inventory_lots il
WHERE il.shelf_code = :shelfCode
  AND il.part_no = :partNo
GROUP BY il.part_no
```

Insert one `goods_verify_tasks` row per shelf with the `movements` JSONB.

**Idempotency:** the `(task_date, shelf_code)` unique index makes re-runs
idempotent via `ON CONFLICT DO NOTHING`.

**No-change shelves:** shelves with no `on_hand` movement that day (or only
zero-net-delta movement) produce no task.

### 3. Verify logic (`verifyGoodsVerifyTask`)

Simplify to a pure confirmation:

- Remove `countedQty` parameter and all adjustment logic.
- Remove the ADJUST ledger row write.
- Remove the box verification logic (box items are no longer relevant).
- Just mark the task as `verified` with `verified_by` / `verified_at`.
- Write a `transaction_logs` transition entry.

```sql
UPDATE goods_verify_tasks
SET status = 'verified', verified_by = :actorId, verified_at = :now
WHERE id = :taskId
```

### 4. API changes

#### `GET /goods-verify-tasks` (list)

Returns shelf-level tasks. Each row:

```json
{
  "id": "...",
  "taskDate": "2026-10-17",
  "shelfCode": "A-01",
  "status": "pending",
  "movements": [
    { "partNo": "ABC-123", "wclItemNo": "WCL-456", "qtyChange": -5, "currentTotal": 42 }
  ],
  "movementsCount": 3,
  "verifiedBy": null,
  "verifiedAt": null
}
```

#### `GET /goods-verify-tasks/:id` (detail)

Returns the task with full `movements` array. No lot/box join needed.

#### `POST /goods-verify-tasks/:id/verify`

Body: `{}` (empty — no `countedQty`). Marks the task as verified.

### 5. PDA UI changes

#### List page (`pages/goods-verify/index.vue`)

- Show shelf-level tasks (shelf code as title, movements count as meta).
- Filter by date and status (same as now).
- Tap → detail page.

#### Detail page (`pages/goods-verify/[id].vue`)

- Header: shelf code, task date, status.
- Table/card list of movements:

  | Part | Description | Change | Current Total |
  | --- | --- | --- | --- |
  | ABC-123 | Widget Assembly | -5 | 42 |
  | DEF-456 | Gear Set | +12 | 156 |

- Single "Confirm" button at the bottom.
- No countedQty input, no per-item interaction.

### 6. Nightly cron

No change to `goodsVerifyDayEnd.ts` — it already calls
`generateGoodsVerifyTasks` for yesterday and today. The generation logic
rewrite is transparent to the cron.

### 7. i18n

Add/update keys:

- `goodsVerify.detail.shelf` — shelf code label
- `goodsVerify.detail.change` — "Change" column header
- `goodsVerify.detail.currentTotal` — "Current Total" column header
- `goodsVerify.detail.movements` — "Movements" section title
- `goodsVerify.detail.confirm` — "Confirm" button text
- `goodsVerify.detail.noMovements` — empty state (shouldn't happen, but safety)

Remove (or keep for backward compat):
- `goodsVerify.detail.countedQty`
- `goodsVerify.detail.verify`
- `goodsVerify.detail.expectedQty`

### 8. Testing

#### Backend (`src/db/goodsverify.test.ts`)

- Seed `inventory_transactions` for a shelf with multiple parts, some with
  positive delta, some negative, some zero-net.
- Run `generateGoodsVerifyTasks` → one task per shelf, correct `movements`.
- Re-run → no new tasks (idempotent).
- Shelf with no movement → no task.
- `verifyGoodsVerifyTask` → marks verified, no adjustment.

#### PDA (`pages/goods-verify/`)

- List renders shelf tasks.
- Detail renders movements table.
- Confirm button calls verify API.

## Out of scope

- Adjusting stock from the verify flow (user fixes discrepancies elsewhere).
- Per-item verification within a shelf.
- Historical trend or audit of verify confirmations.
- Changes to the box-based verify flow (`verify/[boxId].vue`).

## Migration plan

1. Write Drizzle migration for schema change.
2. Update `goodsverify.ts` — generation, verify, reads.
3. Update `goodsverify.ts` route — remove `countedQty` from verify body.
4. Update PDA types (`services/types.ts`).
5. Update PDA list + detail pages.
6. Update i18n (en-US, zh-CN, zh-HK).
7. Update/add tests.
8. Manual test: generate tasks, verify on PDA.
