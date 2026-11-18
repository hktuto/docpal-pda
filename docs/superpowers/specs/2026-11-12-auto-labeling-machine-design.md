# Auto Labeling Machine — Design Spec

Date: 2026-11-12
Status: Draft

## Background

Picking labels currently support two `label_source` values in `label_print_rules`:

- `internal` (default) — the PDA prints the label in the warehouse via the label-printing-center print service.
- `external` — the customer provides the label; the PDA shows an info row with no print button.

We introduce a third source: `auto_machine` — the label is printed by a dedicated **auto labeling machine** (自動貼標機). The PDA does not print; it creates a print job record and tells the operator to load material. The machine has a physical button that fetches the newest pending job from our backend, prints and verifies the labels itself, then reports the result back. Retry is done on the machine side.

Only one machine exists today, but the API and table reserve a `machine_id` so more machines can be added later.

## Scope

- Applies only to flows driven by `label_print_rules` (picking labels). Other label types are out of scope.
- Auto-machine jobs do **not** write `label_prints` and do **not** participate in label-mode verify — the machine's verification is the verification.

## Table: `auto_labeling_jobs`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | printing job id, UUID v7 (schema convention) |
| `picking_order_id` | text, not null | source picking order |
| `machine_id` | text, nullable | reserved for multi-machine; NULL today |
| `payload` | jsonb, not null | full label list generated from the template using the order data — the per-`print_template_id` conversion output (`src/db/labelPrintParams.ts`), same shape the internal print path sends upstream |
| `order_snapshot` | jsonb, not null | picking order details for the machine to display/check (order no, brand, customer, etc.) |
| `scan_snapshot` | jsonb, not null | the pick-time scan records: per-package part / qty / `scanned_date_code` / `scanned_lot_code` / `scanned_coo` / `scanned_cow` — the source values the label batch fields were anchored to |
| `status` | text, not null | `pending` → `printing` (machine fetched) → `completed` / `failed` |
| `status_note` | text, nullable | machine-provided note when reporting `failed` (or informative notes) |
| `created_by` | text, not null | username of the PDA user who created the job (same convention as `receiving_invoices_cn.created_by`) |
| `fetched_date` | timestamptz, nullable | when the machine fetched the job |
| `completed_date` | timestamptz, nullable | when the machine reported completion |
| `created_date` / `last_update_date` | standard | schema conventions |

Status enum: `pending` | `printing` | `completed` | `failed`.

## API

Machine-facing endpoints authenticate with a fixed machine token: env `MACHINE_API_TOKEN`. Requests carry `Authorization: Bearer <MACHINE_API_TOKEN>` (same bearer shape as user JWTs but validated against the literal token; no JWT, no actor). The token must be set in production; when `MACHINE_API_TOKEN` is unset the machine endpoints fail closed (401).

### `POST /auto-labeling/jobs/fetch`

Called by the machine's physical button.

- Optional body: `{ "machineId": "..." }` — filter by machine. Default (no id / NULL machine_id job): return the **newest** `pending` job by `created_date`.
- Marks the returned job `printing`, stamps `fetched_date`.
- Response: `{ job }` with `payload`, `order_snapshot`, `scan_snapshot`, `id` (for the report-back call).
- 404 `auto_labeling_no_pending_job` when nothing is pending.

### `PATCH /auto-labeling/jobs/:id`

Called by the machine with the job id it fetched.

- Body: `{ "status": "completed" | "failed", "note": "..." }`.
- Allowed transitions: `printing` → `completed` / `failed` (also allows a retry loop `failed` → …; a `failed` job may be re-claimed by the machine — see Re-entry below).
- Stamps `completed_date` when terminal.
- 404 `auto_labeling_job_not_found`; 409 `auto_labeling_job_state` on an illegal transition.

### Re-entry / retry

Retry is done **on the machine**. To support it, `fetch` accepts a `jobId` in the body — the machine re-fetches a specific `printing`/`failed` job it already knows (idempotent claim: re-fetching a `printing` job returns it unchanged with the remaining `payload`). New fetches without `jobId` only pick up `pending` jobs.

## Backend wiring

- `label_print_rules.label_source` gains `auto_machine` (admin CRUD + `POST /admin/label-print-rules/test-match` + `GET /picking-orders/:id/label-print-rules` all pass the value through; validation updated).
- `POST /picking-orders/:id/label-print` rejects `auto_machine` rules the same way it rejects `external` (409), because the PDA takes a different route for them.

## PDA flow

In the picking-finish label print prompt (`components/picking/LabelPrintPrompt.vue`) and the picking detail "Print labels" action:

1. Rule resolves with `label_source: auto_machine` → the PDA calls a new backend endpoint, e.g. `POST /picking-orders/:id/auto-labeling-jobs`, which:
   - resolves the rule + template conversion server-side (same `labelPrintParams` conversion as the internal path),
   - builds `order_snapshot` + `scan_snapshot` from `getPickingOrderDetail` (including the `scanned_*` package columns),
   - inserts the `auto_labeling_jobs` row (`status: pending`, `created_by` = actor from JWT),
   - records nothing in `label_prints`.
2. The screen shows a **load-material prompt**: "請裝載材料 / Please load the material" — no further PDA confirmation; the operator presses the physical button on the machine when ready.
3. `labelCount` display follows the existing rule match output.

Job status is visible where useful (picking detail shows the auto job's status with a refresh; the machine is authoritative for completion).

## Auth summary

- PDA endpoints: normal user JWT.
- Machine endpoints (`/auto-labeling/fetch`, `PATCH /auto-labeling/jobs/:id`): `MACHINE_API_TOKEN` bearer; excluded from user-JWT enforcement but still behind the global auth middleware (token comparison inside the auto-labeling routes).
- Fail closed when the env is unset.

## Out of scope

- Multi-machine scheduling (only `machine_id` plumbing reserved).
- Cancelling a job from the PDA (retry/abandon happens on the machine; a stuck `printing` row can be corrected admin-side if ever needed).
- Admin console UI for the job list (can be added later; the table is queryable directly for now).
