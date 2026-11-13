# UAT inventory tools — design

Date: 2026-11-13
Branch: `feat/uat-inventory-tools`

Two admin-console tools for UAT/demo environments:

1. **Per-shelf inventory Excel import** — credit stock directly onto a shelf
   from an .xlsx, without a receiving order. Ships with the product.
2. **Remove-all-inventory (UAT tooling)** — a guarded wipe of all on-hand
   inventory state so a UAT database can be reset from the UI. Always
   available to admins (no env flag) and **must be removed or re-gated
   before a production release** — see §2 "Guard".

## 1. Per-shelf inventory Excel import

### Why

UAT testers need realistic on-hand stock on specific shelves to exercise
put-away/picking/verify flows without building a full receiving order each
time. The existing ad-hoc put-away flow is PDA-side and scan-driven; admins
want a spreadsheet-driven equivalent per shelf.

### API

- `GET /admin/shelves/import-inventory/org-options?shelfCode=`
  → `{ pairs: [{ orgId, code, description }] }` — the (org_id,
  sub_inventory_code) pairs the modal may offer: all `org_info` rows,
  restricted to the shelf's `sub_inventory_scopes` (`NULL`/empty =
  unrestricted). 404 `shelf_not_found`.
- `POST /admin/shelves/import-inventory`
  Body: `{ shelfCode, orgId, subInventoryCode, rows: [{ wclItemNo, dateCode, qty }] }`
  Response: `{ ok, inserted, merged, errors: [{ row, message }] }`.

### Server behaviour (`src/routes/admin/shelfInventoryImport.ts`)

One `db.transaction`, `actorId` from the JWT (`actorFrom(c)`):

1. Shelf must exist (404 `shelf_not_found`).
2. Scope validation — ONE request-level error, not per-row: if the shelf has
   non-empty `sub_inventory_scopes`, the requested pair must be in them
   (422 `org_sub_inventory_outside_shelf_scope`); the pair must exist in
   `org_info` (422 `org_sub_inventory_not_found`).
3. Per row: exact `parts.wcl_item_no` match (unique column). Not found →
   per-row error `unknown wcl_item_no: <value>`, remaining rows continue.
   **Valid rows commit** — all-or-nothing is deliberately NOT used (mirrors
   `shelfBatchImport.ts`), because a 500-row sheet with one typo should not
   throw away the other 499.
4. Lot upsert on the partial unique key `(part_no, date_code, coo, cow,
   shelf_code, box_id, org_id, sub_inventory_code)` with coo/cow/box_id
   NULL: an existing lot (same part + date_code + shelf + pair, box_id IS
   NULL) gets `total_qty += qty` (`merged++`), otherwise a new lot is
   inserted with `allocated_qty = 0` (`inserted++`).
5. One `inventory_transactions` row per touched lot: `txn_type 'ADJUST'`,
   `qty_type 'on_hand'`, `qty_delta = +qty`, `txn_reason 'admin import'`,
   batch snapshot fields (part_no/date_code/shelf) filled, `actor_id` set,
   `reference_type 'inventory_import'` / `reference_id` = shelfCode.
6. One `transaction_logs` row for the import: `entity_type
   'inventory_import'`, `entity_id` = shelfCode, `to_state 'imported'`,
   metadata `{ inserted, merged, orgId, subInventoryCode }`.

New stock participates in allocation at the admin's next Re-allocate
(manual-only allocation — no automatic recompute).

### Client (`apps/admin`)

- `apps/admin/pages/shelves.vue` row-actions gains an "Import" button opening
  `components/ShelfInventoryImportDialog.vue`.
- The dialog: single-select `SearchableSelect` (`multiple: false`) of the
  allowed org pairs (labels `2 / HK-SUB (description)`), then a hidden file
  input + button (mirrors `receiving-cn/new.vue`). Read with dynamic
  `await import("xlsx")`, first sheet, `sheet_to_json(ws, { header: 1,
  defval: "" })`.
- Format: exactly `wcl_item_no | date_code | qty`, first row header. Column
  indices come from the header row (case-insensitive); extra columns are
  ignored; a missing/renamed required column aborts with a client-side error.
- Client validation: qty positive integer, wcl_item_no non-empty,
  date_code blank → null. Per-row problems are listed and abort the import.
- On success: `{inserted}/{merged}` banner + table reload. Per-row server
  errors render in the dialog.

## 2. Remove-all-inventory (UAT only)

### Guard

**No env flag.** The wipe route is registered unconditionally and the admin
button always renders — the only gate is the `/admin/*` admin-group
middleware plus the UI's confirm dialog, which requires typing `DELETE`
before the POST fires. (An earlier revision of this spec gated both behind a
`UAT_TOOLS` env flag; that was dropped — the user will remove the feature
manually after UAT and wants no env configuration.)

⚠️ **Must be removed or re-gated before a production release.** The route
and button are UAT tooling; nothing prevents an admin from wiping all
on-hand inventory in any environment where this code ships.

### Effect (`src/routes/admin/uatInventoryWipe.ts`)

Single `db.transaction`, `actorId` from the JWT, `SET LOCAL
app.sync_events_off = 1` at tx start (mirrors `resetAndReseed`,
`src/db/seed.ts`) so the external sync feed is not spammed:

1. `DELETE FROM allocations`
2. `DELETE FROM inventory_lot_sources` (also ON DELETE CASCADE from lots,
   but explicit for clarity and countability)
3. `goods_verify_tasks.inventory_lot_id` — **decision: SET NULL, do not
   delete the tasks.** The column is nullable and *legacy* since the
   2026-10-17 goods-verify redesign (tasks are per-shelf daily movement
   summaries; only the old leftover `inventory_lot_id` pointer references
   lots, and it has no FK). Deleting daily confirmation records would lose
   audit history; nulling the dangling pointer is the safe option.
4. `DELETE FROM inventory_transactions`
5. `DELETE FROM transaction_logs`
6. `DELETE FROM inventory_lots`

The wipe then writes a single surviving `transaction_logs` row
(`entity_type 'uat_inventory_wipe'`, `to_state 'wiped'`, metadata
`{ deletedLots }`, actor = the admin) so the destructive action itself is
auditable. Response: `{ ok: true, deletedLots }` with the real lot count.

### Client (`apps/admin/pages/stock-search.vue`)

Red danger button in `.page-head`, always rendered for admins. Click opens a
confirm dialog that requires typing `DELETE` before the POST fires. After
success: a success banner shows the deleted lot count and the summary/table
reload.

## Files

- `apps/backend/src/routes/admin/shelfInventoryImport.ts` (new)
- `apps/backend/src/routes/admin/uatInventoryWipe.ts` (new)
- `apps/backend/src/routes/admin/index.ts` (mounts, wipe unconditional)
- `apps/backend/src/routes/admin/uatInventoryTools.test.ts` (new)
- `apps/admin/components/ShelfInventoryImportDialog.vue` (new)
- `apps/admin/pages/shelves.vue`, `apps/admin/pages/stock-search.vue`,
  `apps/admin/utils/flowApi.ts`
- `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`
- `scripts/gen-inventory-import-template.mjs` →
  `supporting_doc/inventory-import-template.xlsx`
