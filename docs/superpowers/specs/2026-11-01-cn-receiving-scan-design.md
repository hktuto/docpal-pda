# CN Receiving Scan Task (PDF path) — Design

Date: 2026-11-01
Status: implemented
Plan: `docs/superpowers/plans/2026-11-01-cn-receiving-scan.md`
Builds on: `2026-10-16-customer-receiving-upload-design.md`, `2026-10-27-manual-receiving-pda-design.md`

## Problem

CN receiving orders are created two ways:

1. **Manual receiving (PDA)** — the operator scans every physical item, then commits; the order is inserted `in_hand` with a `put_away_tasks_cn` row. The scan already happened, so put-away work reflects reality.
2. **PDF upload (admin) → DocPal OCR workflow → upstream sync → admin confirm** — `POST /admin/receiving-cn/orders/:batchNo/confirm` (`confirmCnOrder`) immediately filled `received_qty = line_qty`, stamped the order `in_hand`, and created the put-away task. The OCR'd paper trail became stock work with **no physical verification**: missing cartons, wrong parts, and qty discrepancies all sailed straight into put-away.

## Decision

Insert a **receiving scan step** into the PDF path between OCR confirm and put-away. The manual-receiving path is unchanged (it is already a scan).

### Order status

`receiving_orders_cn.status` gains **`scanning`**: `pending → scanning → in_hand → clear`.

- `confirmCnOrder` (admin confirm) and `finalizeCnOrder` (cron fallback) now move the order to `scanning` via `startCnReceivingScanTx` — arrival stamped, **no** `received_qty` fill, **no** put-away task. SSE `receiving_cn.scan_started`.
- The old shared `receiveCnOrderTx` is replaced; the receipt moment is now the scan-task finalize.

### Item scan state

New columns on `receiving_invoice_items_cn`:

| column | values |
| --- | --- |
| `scan_status` | NULL (unresolved) \| `ok` \| `warning` \| `error` |
| `scan_qty` | physically scanned qty |
| `scan_reason` | `qty_mismatch` (auto warning) \| `missing` \| `damaged` \| `wrong_part` \| `other` |
| `scan_note` | free text |
| `scanned_by` / `scanned_at` | actor + time |

A scan whose qty differs from `line_qty` is a **warning** (`qty_mismatch`). User flags are **errors**. Error flags also mirror into the pre-existing (previously dormant) mismatch columns (`reported_mismatch`, `mismatch_reason`, `mismatch_note`, `wrong_part_no`) so the admin console shows them through the existing mismatch display. A successful scan also overwrites the item's `date_code`/`lot_code`/`coo`/`cow` with the physically scanned values — put-away later builds the lot from the item row, so the lot must carry the physical truth, not the OCR guess.

### Endpoints (PDA, user JWT, `cnReceiving()`-gated)

- `GET /receiving-cn/scan-tasks` — orders at `scanning` with `itemCount`/`resolvedCount` progress.
- `GET /receiving-cn/scan-tasks/:id` — order + items with scan state (404 `receiving_cn_scan_task_not_found` unless scanning).
- `POST /receiving-cn/scan-tasks/:id/items/:itemId/scan` `{qty, dateCode?, lotCode?, coo?, cow?, raw?}` — marks the item `ok`/`warning`.
- `POST /receiving-cn/scan-tasks/:id/items/:itemId/flag` `{reason, note?, wrongPartNo?}` — marks the item `error`.
- `POST /receiving-cn/scan-tasks/:id/items/:itemId/reset` — back to unresolved.
- `POST /receiving-cn/scan-tasks/:id/finalize` `{unresolvedAs?: 'missing'}` — the new receipt moment.

Label parsing/matching stays client-side (same as manual receiving): the PDA parses the label with supplier scan templates and matches it against the order's unresolved items by part no / wcl item no; the server only records outcomes. Each scan/flag is its own small tx (not local staging) because the order is a shared server-side entity the admin console can also see.

### Finalize semantics — "only clean items are put away"

One tx:

- unresolved items → 409 `unresolved_items`, unless `unresolvedAs: 'missing'` flags them in the same tx;
- `ok` items → `received_qty = scan_qty`;
- `warning` and `error` items → `received_qty = 0` — the CN put-away detail derives remaining as `received − picked − put_away`, so these items can never be put away;
- order → `in_hand` (+ arrived stamp); `put_away_tasks_cn` inserted (`ON CONFLICT (receiving_order_cn_id) DO NOTHING`), only when at least one `ok` item exists;
- audit rows + `receiving_cn.completed` SSE (topics `/admin/receiving-cn`, `/put-away-tasks`, `/receiving-cn-scan-tasks`).

Warning/error items keep their `scan_qty`/`scan_reason`/`scan_note` on the order for admin follow-up. Re-admitting a held-back item to stock is deliberately out of scope (admin-side correction flow).

### PDA

New home tile 收貨掃描 (gated by the existing `receiving-cn` flow-step flag) → `pages/receiving-cn-scan/index.vue` (task list with progress, `useVisibleReload` on `/receiving-cn-scan-tasks`) → `pages/receiving-cn-scan/[id].vue`:

- item rows with unresolved / ok / warning / error chips;
- hardware scanner + camera OCR entry, client-side template parse + match against unresolved items; no-match → error feedback, multi-match → chooser, duplicate raw label → rejected;
- per-item Flag dialog (missing / damaged / wrong part / other + note) and Reset;
- finalize with a "mark remaining as missing" option → navigate to `/put-away`.

### Admin

Order detail shows the `scanning` status and per-item scan outcome (status, scanned qty vs line qty, reason, note); the list status filter gains `scanning`. The confirm button now means "OCR verified — send to PDA scanning".

## Alternatives considered

- **Local staging + single commit (manual-receiving style)**: rejected — the order already exists server-side and is visible to admin; per-scan commits keep both clients consistent and survive app restarts.
- **New flow-step flag for the scan step**: rejected — the step is inherent to the PDF path; manual receipts bypass it by construction. The whole CN world is already gated by `receiving-cn`.
- **Warnings still go to put-away**: rejected per requirement — only items with no warning and no error become put-away work.
