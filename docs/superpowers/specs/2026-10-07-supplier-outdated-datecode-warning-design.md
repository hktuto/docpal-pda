# Supplier Outdated Date-Code Scan Warning — Design

Status: draft (2026-10-07)

## Problem

Warehouse operators can pick or put away stock whose label date code is older
than the supplier's acceptable age. Today nothing flags this at scan time; the
only age concept is `outdatedStockYears`, an admin stock-search summary
statistic.

## Goal

Per-supplier outdated limit (in months, default 12, nullable = no check). When
a PDA user scans or OCR-captures an item during **picking** or **put-away** and
the label's date code is older than the supplier's limit:

1. The scan **succeeds** (the package/scan row is created) — the user keeps
   working.
2. The PDA shows an alert naming the supplier, date code, and limit.
3. The backend records a warning row and notifies the admin console (SSE).
4. The order shows a warning badge (PDA list/detail + admin list/detail).
5. Task completion is blocked until an admin resolves the order's warnings:
   - `POST /picking-orders/:id/finish` → 409 `unresolved_outdated_warnings`
   - `POST /receiving-orders/:id/put-away-commit` → 409 `unresolved_outdated_warnings`

Scope decisions (confirmed with requester):

- Flows: picking scan + put-away scan only. NOT receiving scan or
  goods-verify/measuring.
- Labels with no/unparseable date code, or items whose supplier has no
  profile: **no check** (silently pass).
- Resolution is **whole order at once** (one admin action resolves all
  unresolved warnings on the order, with a note stamped on each row).
- The order **status enum is unchanged** — the warning is a derived
  flag/count, not a new `picking_orders.status` value (a new status would
  fight the allocation state machine and the admin status overrides).

## Data model

### `supplier_profiles.outdated_limit_months`

`integer NULL`. NULL = no outdated check for this supplier. New rows default
to 12 (application-level default in the admin form; existing rows backfill to
12 via migration). Editable on the admin supplier-profile page; clearing the
field stores NULL.

### New table `outdated_scan_warnings`

| column | type | notes |
| --- | --- | --- |
| `id` | text PK | UUID v7 via `newId()` |
| `order_kind` | text NOT NULL | `'picking'` \| `'putaway'` |
| `order_id` | text NOT NULL | picking order id / receiving order id (no FK — different targets per kind) |
| `order_item_id` | text | picking item id / receiving item id |
| `package_id` | text | the created `picking_packages` / put-away scan row id |
| `supplier_code` | text NOT NULL | from the matched supplier profile |
| `wcl_item_no` | text | business key of the part |
| `part_no` | text | display |
| `date_code` | text NOT NULL | the scanned WWYY (post `date_code_encoding` decode) |
| `limit_months` | integer NOT NULL | supplier limit snapshot at scan time |
| `qty` | integer | scanned qty |
| `scanned_by` | text NOT NULL | actor id from the JWT |
| `scanned_at` | timestamp NOT NULL | |
| `resolved_at` | timestamp | NULL = unresolved |
| `resolved_by` | text | admin actor id |
| `resolution_note` | text | |
| `created_date` / `last_update_date` | timestamp NOT NULL | standard convention |

Unresolved count per order =
`COUNT(*) WHERE order_kind=? AND order_id=? AND resolved_at IS NULL`.

## Check logic — `src/db/outdated.ts`

New module, called from the scan paths:

- `checkOutdatedDateCode(db, {supplierCode, dateCode, now})` →
  `{outdated: false}` | `{outdated: true, limitMonths}`.
  - Load the supplier profile by code; missing profile or
    `outdated_limit_months IS NULL` → not outdated.
  - Missing/invalid WWYY → not outdated.
  - Age comparison reuses the WWYY rank approach from `stocksearch.ts`
    (`dateCodeRank` / `dateToDateCode`, incl. the 2-digit-year window):
    threshold = rank of the WWYY exactly `limit_months` before `now`;
    `rank(dateCode) < threshold` → outdated. Extract the rank helpers into a
    shared module (`src/db/dateCode.ts`) used by both stocksearch and this
    check; `stocksearch.ts` keeps its SQL-side rank expression.
- `recordOutdatedWarning(tx, {...})` — insert row + `emitEvent`
  (`outdated.warning.created`, topics `["/admin/outdated-warnings", orderTopic]`)
  inside the scan transaction, so a rolled-back scan leaves no warning.

### Call sites

- `scanPickingItem` (`src/db/picking.ts`) — after the package is created,
  inside the same tx. Supplier identity = the supplier profile whose QR
  template/brand matched the scan (the scan flow already resolves this for
  template matching; the matched profile's `supplierCode` is threaded into the
  check). Same for the `shipping-boxes/:id/scan` path.
- Put-away scan (`src/routes/putaway.ts` → `src/db/putaway.ts`,
  `POST /receiving-orders/:id/put-away-scans`) — same pattern; the receiving
  order's supplier is known directly (`supplier_code` on the order).
- OCR capture goes through the same scan endpoints with the parsed fields, so
  it is covered automatically (the PDA sends the decoded `dateCode`).

### Scan responses

Scan endpoints stay 2xx. The response gains:

```json
"outdatedWarning": { "supplierCode": "...", "dateCode": "3724", "limitMonths": 12 }
```

(absent/null when clean). The PDA shows a dismissible alert dialog:
"Outdated date code WWYY — supplier limit N months. Admin has been notified."
and scanning continues.

## Blocking completion

- `finishPickingOrder` and the put-away commit domain function query
  unresolved warning count for the order first; `> 0` →
  `HTTPException(409, "unresolved_outdated_warnings")` with the count in the
  error body so the PDA can render "N unresolved outdated warnings — ask an
  admin to resolve".
- Admin order status overrides (`PATCH /admin/picking-orders/:id/status`) are
  NOT blocked — admins are the resolution authority.

## Order surfaces

- `GET /picking-orders` rows + `GET /picking-orders/:id`: add
  `outdatedWarningCount` (unresolved). PDA picking list/detail show a warning
  chip when > 0; admin picking list/detail show the same.
- Put-away list/detail (receiving orders): same field; warning chip on the
  PDA put-away list and admin receiving detail.
- No change to allocation, statuses, or list filtering.

## Admin API + console

- `GET /admin/outdated-warnings?resolved=false&orderKind=` — list with order
  no, part, supplier, date code, scanned by/at.
- `POST /admin/outdated-warnings/resolve-order`
  `{orderKind, orderId, note}` — stamps `resolved_at/resolved_by/
  resolution_note` on all unresolved rows for the order (tx), emits
  `outdated.warning.resolved`. Whole-order resolution per decision.
- Admin console: new "Outdated warnings" page (pending count badge in nav),
  reachable from the picking/receiving detail warning chip; resolve dialog
  with note field. Subscribes to the SSE topic for live updates.
- Supplier profile CRUD gains the `outdated_limit_months` field (number
  input, empty = no limit, default 12 for new profiles).

## SSE events

- `outdated.warning.created` — topics: `/admin/outdated-warnings`, the
  order's topic (`/picking-orders` / `/receiving-orders`).
- `outdated.warning.resolved` — same topics.

Both added to `docs/backend/event-catalog.md`.

## PDA changes

- Scan pages (picking scan, put-away detail): on `outdatedWarning` in the
  scan response show the alert dialog (reuse the existing alert/confirm
  dialog pattern); scanning continues after dismiss. OCR capture path shows
  the same dialog.
- Picking + put-away list rows and detail headers: warning chip when
  `outdatedWarningCount > 0`.
- Finish / commit 409 handling: show the server message.

## Tests

- Backend (`node:test`):
  - check logic: boundary at exactly N months, NULL limit, missing profile,
    invalid date code, 2-digit-year window edge.
  - picking scan with outdated label → 201 + `outdatedWarning` + warning row
    + SSE event; clean label → no field.
  - put-away scan same.
  - finish / put-away-commit blocked with 409 while unresolved; succeeds
    after `resolve-order`.
  - resolve-order stamps all rows + emits event; idempotent on re-resolve.
- PDA (vitest): warning dialog rendering from a scan response; list chip.

## Migration / rollout

- `pnpm --filter @warehouse/backend db:generate` — adds
  `supplier_profiles.outdated_limit_months` (backfill 12 where NULL is not
  intended: existing profiles get 12; admins clear to NULL to opt out) and the
  `outdated_scan_warnings` table.
- Docs: `docs/backend/api-design.md`, `docs/backend/event-catalog.md`,
  `docs/backend/schema-tables.md`, `docs/app-docs/flows/picking/` +
  `flows/put-away/` (overview/steps/ai-scope), `ai/feature-registry.md`,
  `ai/code-map.md`, and the `supplier_profiles` paragraph in `AGENTS.md`.

## Non-goals

- Receiving scan / goods-verify outdated checks.
- Per-warning (individual) resolution.
- Blocking the scan itself or auto-holding the order's status.
- Push notification beyond the admin console SSE/badge.
