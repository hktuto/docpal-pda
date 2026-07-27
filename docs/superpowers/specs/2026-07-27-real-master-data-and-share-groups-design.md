# Real master-data seed + sub-inventory share groups — design

Date: 2026-07-27
Status: approved, implementing

## Background

Four new real-data sources arrived under `new_seed/`:

1. `ORIGINAL_ID + ORG_ID + Sub Inventory mapping.xlsx` — the real Oracle
   org → sub-inventory mapping (sheet `Enable Subinv Data`: 151 rows across 13
   orgs: 2, 5, 7, 9, 12, 14, 21, 82, 100, 120, 140, 143, 220). Unlike the old
   hand-made `subInventories.xlsx`, it has **no tag column** — every row is a
   real `SECONDARY_INVENTORY_NAME`. So the real data alone cannot tell the
   picking logic which sub-inventory stores may share stock.
2. `parts_table.xlsx` — full Oracle item master (sheet `Item table`, 132,681
   rows: `INVENTORY_ITEM_ID, SEGMENT1, DESCRIPTION, BRAND, COO, MPN`).
3. `weight/KOA N.W.xls` + `weight/other.xls` — net-weight references. Column B
   is the WCL item no, column C the unit weight in KG (brand column ignored).
4. `210726.xls` — a new receiving order: 502 rows, 107 invoices (each
   single-brand; 9 brands total: KOA, ICHAUS, NCC, SII, MMC, NITSUKO,
   DEXERIALS, TE, KYOCERA), 259 cartons.

## 1. Sub-inventory share groups

Allocation still matches a picking order's `(org_id, sub_inventory_code)`
pair against the source's pair. What changes: a warehouse can declare that
certain sub-inventories **share** their stock.

New table `sub_inventory_share_members`:

- `share_group text not null` — free-text group code, chosen per warehouse.
- `org_id int not null`, `code text not null` — composite FK →
  `sub_inventories (org_id, code)`.
- PK `(org_id, code)` — a sub-inventory belongs to at most one share group.
- Index on `share_group`.

Semantics in the allocation engine (`src/db/allocate.ts`): a demand with pair
`(org, S)` matches a source with pair `(org', S')` when

- the org rule passes (unchanged: demand org NULL = org-agnostic, else
  `org' = org`), and
- `S = S'`, **or** both `(org, S)` and `(org', S')` are members of the same
  `share_group`.

Sharing is symmetric and transitive within the group. The customer-segregation
rule is unchanged: a source in a sub-inventory with `customer_code` still only
serves orders of that customer (so putting a segregated store in a share group
does not leak its stock to other customers).

Configuration is manual per warehouse (admin console, sub-inventories page —
inline "share group" editor backed by
`/admin/sub-inventory-share-groups`). The seed ships the table empty except one
demo group: org 2 `STORE1` + `WSTORE1` in group `HK`.

## 2. Real sub-inventory master

All 151 rows of the mapping are seeded as sub-inventory **groups**
`(org_id, code = SECONDARY_INVENTORY_NAME, name = SUBINV_DESCRIPTION)`, each
with a single self-tag (`tag = code`) in `sub_inventory_tags`. The existing
demo groups (ACME-S1, the 140/143 STORE1 groups with their legacy tags,
DEFAULT, …) stay — the legacy tags are still referenced by
`LEGACY_TAG_GROUPS` when remapping older real-data seed rows, and names do not
collide with the real ones.

## 3. Parts master

`parts_table.xlsx` → `parts` + `suppliers`:

- `wcl_item_no` = `SEGMENT1` verbatim.
- Split `SEGMENT1` on the **first** occurrence of `/`, `+`, `-`, or `*`:
  prefix → `supplier_code`, remainder with **all whitespace removed** →
  `part_no`. Examples: `ABBYY/BC2` → supplier `ABBYY`, part `BC2`;
  `DIOTEC+US1J` → supplier `DIOTEC`, part `US1J`;
  `KOA+RK73H2BTTD 1004F` → part `RK73H2BTTD1004F` (matches the existing seed
  convention, so old seed rows and the new master merge on `part_no`).
- `description` = DESCRIPTION; `default_coo` = COO (`--` → NULL).
- Rows without any delimiter (31 junk rows: ADJUSTMENT, CANCELLATION FEE, …)
  are skipped.
- `part_no` is UNIQUE in the schema but not in the source (COO/brand variants
  like `KOA/RK73…` JP vs `KOA+RK73…` CN collapse): dedupe keep-first
  (~100,267 distinct part_no).
- One `suppliers` row is auto-created for every distinct prefix not already
  seeded (162 prefixes; `KOA`/`DAITO`/`KOA+TCG` stay as-is — `KOA+TCG` remains
  for the QR-template supplier profile).

Bulk parts are generated to `src/db/seed-parts-data.json` and inserted in
chunks with `onConflictDoNothing()`. **Tests opt out**: `seedAll` gains
`opts.bulkParts` (default true); `test-helper.ts` passes `false` so the test
world stays small and fast.

## 4. Weight formulas

Both weight xls files → `net_weight_formula`: column B (`wcl_item_no`) is
split exactly like parts to get `part_no`; column C is the unit weight in KG
→ `qty = 1`, `weight = kg × 1000` grams. Rows whose part_no is not in the
seeded parts map, or with a non-positive/non-numeric weight, are skipped;
duplicates keep the first. This replaces the two hand-written demo rows.

## 5. Receiving order 210726

`210726.xls` → one **multi-supplier** receiving order (a receiving order may
have multiple suppliers — the schema already allows this: both
`receiving_orders.supplier_id` and `receiving_invoices.supplier_id` are
nullable):

- Order: `batch_no = '210726'`, `supplier_id = NULL`, `delivery_date =
  2026-07-21`, `org_id = 2`, `sub_inventory_code = 'STAGING'` (exists in the
  real org-2 master), `status = 'pending'`.
- One invoice per `INVOICE NO` (107): `supplier_id` = the row for the item
  brand (invoices are single-brand), `wcl_company_name = OFFICE NAME`,
  `total_ctn` = distinct `C/No.` count, `total_qty` = Σ `Quantity`,
  `org_id = 2`, `sub_inventory_code = NULL`.
- Items: `part_no` = split+strip of `Our P/No.` (must exist in the seeded
  parts — generator warns/skips otherwise), `wcl_item_no` verbatim,
  `po_no = PO NO`, `line_qty = Quantity`, `ctn_no = C/No.`,
  `coo = 產地` verbatim (Chinese free text, e.g. 中國).
- Dropped: `Size`, `G.W` (no schema home), the trailing 合板/紙板/膠板 summary
  rows (no invoice no), and the `產品` category column.

## 6. Generator

One committed, re-runnable script `scripts/gen-seed-real-data.mjs` (repo root,
uses `xlsx`) regenerates all four generated artifacts from `new_seed/`:

- `src/db/seed-subinventories-data.ts` — 151 groups + self-tags.
- `src/db/seed-parts-data.json` — bulk parts + supplier code list.
- `src/db/seed-net-weight-data.ts` — weight rows (part_no + grams).
- `src/db/seed-order-210726.ts` — order/invoices/items (fixed UUIDs in the
  `…3000+` range, `supplierCode` on invoices resolved to ids at seed time).

## 7. Admin parts server-side paging

~100k parts break the client-side-paged admin list. `createCrudRouter` gains
an optional `search?: (q) => SQL`; when `?page`/`?pageSize`/`?q` are present
it returns `{ rows, total }` (LIMIT/OFFSET + COUNT). The parts entity uses it
(search over `part_no`/`wcl_item_no`/`description` ILIKE); all other entities
keep the existing full-list behavior. The admin `CrudTable` switches to server
mode via a `serverPaging` flag in the entity config (search box + `Pager`
driven by the server total).
