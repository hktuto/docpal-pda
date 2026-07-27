# Plan: real master-data seed + sub-inventory share groups

## Goal

Ingest the four new seed sources under `new_seed/`, plus one schema/allocation feature:

1. **Sub-inventory share groups** — new table so each warehouse can declare which sub-inventories share stock for picking allocation (match stays `org_id` + `sub_inventory_code`, share groups widen it).
2. **Real org/sub-inventory master** — all 151 sub-inventories / 13 orgs from `new_seed/ORIGINAL_ID + ORG_ID + Sub Inventory mapping.xlsx` (no tag column → each becomes a group with a self-tag).
3. **Parts master** — all ~132k rows of `new_seed/parts_table.xlsx` (~100k distinct part_no after split/dedup), plus auto-created suppliers for the 162 prefixes; admin parts list gets server-side paging.
4. **Weight formulas** — `new_seed/weight/KOA N.W.xls` + `other.xls` → `net_weight_formula` (qty=1, weight = col C kg × 1000 g).
5. **Receiving order 210726** — `new_seed/210726.xls`: one multi-supplier order (order-level supplier NULL, per-invoice supplier), org 2 / `STAGING`, batch_no `210726`, delivery 2026-07-21, status pending.

## Confirmed decisions (from user)

- Share table: manual per warehouse; seed empty except one demo group for org 2; admin UI included.
- 210726: `batch_no='210726'`, org 2, sub-inventory `STAGING`, delivery_date 2026-07-21, pending.
- Parts: seed all; add server-side search/paging to admin parts.
- part_no = remainder after first `/ + - *`, **spaces stripped** (`KOA+RK73H2BTTD 1004F` → `RK73H2BTTD1004F`); `wcl_item_no` = `SEGMENT1` verbatim.

## Key data facts (verified)

- Mapping xlsx sheet `Enable Subinv Data`: `OFFICE_CODE, ORGANIZATION_ID, ORG_ID, SECONDARY_INVENTORY_NAME, SUBINV_DESCRIPTION`; 151 rows, orgs {2,5,7,9,12,14,21,82,100,120,140,143,220}.
- parts_table sheet `Item table`: `INVENTORY_ITEM_ID, SEGMENT1, DESCRIPTION, BRAND, COO, MPN`; 132,681 rows; 31 junk rows have no delimiter (skip); 162 distinct supplier prefixes; ~100,267 distinct part_no (strip-spaces, keep-first dedup).
- Weight files: col B = wcl_item_no, col C = unit weight KG; brand column irrelevant per user.
- 210726.xls: 502 rows; 107 invoices (each single-brand, 9 brands: KOA, ICHAUS, NCC, SII, MMC, NITSUKO, DEXERIALS, TE, KYOCERA); 259 cartons; trailing 合板/紙板/膠板 summary rows have no invoice no (skip). Columns: `C/No., Size, G.W, INVOICE NO, OFFICE NAME, PO NO, Our P/No., Quantity, 產品, Description, 產地`. Size/G.W have no schema home → dropped (noted in spec).
- Existing `receiving_invoices.supplier_id` is nullable; `receiving_orders.supplier_id` nullable — multi-supplier needs **no schema change**.
- Existing seed part numbers already use the strip-spaces convention, so old and new parts merge by part_no.
- Tests reseed via `resetAndReseed(..., { stockBoxes: false })` — bulk parts must be opt-out for tests or the suite dies (100k inserts per reset).

## Steps

### 1. Spec doc
Write `docs/superpowers/specs/2026-07-27-real-master-data-and-share-groups-design.md` covering: share-group semantics, split/dedup rules, 210726 mapping (incl. dropped Size/G.W), test opt-out for bulk parts.

### 2. Share-group schema + migration
- `apps/backend/src/db/schema/master.ts`: new table
  `sub_inventory_share_members` — `shareGroup text not null`, `orgId int not null`, `code text not null`; PK `(org_id, code)` (a sub-inventory joins at most one group); composite FK `(org_id, code)` → `sub_inventories`; index on `share_group`.
- Export from `schema/index.ts`; add `"sub_inventory_share_members"` to `ALL_TABLES` in `seed.ts` (before `sub_inventories`).
- `pnpm --filter @warehouse/backend db:generate` for the migration.

### 3. Allocation change (`apps/backend/src/db/allocate.ts`)
In `loadLotSources` and `loadReceivingSources`, widen the sub-inventory match:
```sql
AND (${d.subInventoryCode}::text IS NULL
     OR il.sub_inventory_code = ${d.subInventoryCode}
     OR EXISTS (SELECT 1 FROM sub_inventory_share_members a
                JOIN sub_inventory_share_members b ON b.share_group = a.share_group
                WHERE a.org_id = ${d.orgId} AND a.code = ${d.subInventoryCode}
                  AND b.org_id = il.org_id AND b.code = il.sub_inventory_code))
```
(same shape for the receiving-source query with `ro.*`). Org filter and `si.customer_code` segregation rules unchanged. Update the header comment. Extend `allocate.test.ts`: lot in a shared sub-inventory serves a demand naming a sibling member; non-member still excluded; customer-segregated member still restricted.

### 4. Share-group admin API + UI
- Backend: new `apps/backend/src/routes/admin/subInventoryShareGroups.ts` — `GET /admin/sub-inventory-share-groups` (members joined with sub-inventory names, grouped), `PUT /admin/sub-inventory-share-groups/:orgId::code` `{shareGroup}` (upsert; empty/null = remove), `DELETE .../:orgId::code`. Register in `routes/admin/index.ts`.
- Admin console `apps/admin/pages/sub-inventories.vue`: add a "Share group" column with inline edit (text input + save) hitting the new endpoints; i18n keys in `layers/i18n/i18n/locales/*.ts` for the column label.

### 5. Seed generator script (reproducible this time)
New `scripts/gen-seed-real-data.mjs` (repo root, ESM, uses `xlsx` — add `xlsx` to root `package.json` devDependencies; it's already physically in root `node_modules`). One script regenerates everything from `new_seed/`:
- `apps/backend/src/db/seed-subinventories-data.ts` — all 151 groups `{orgId, code, name: SUBINV_DESCRIPTION}` + self-tags.
- `apps/backend/src/db/seed-parts-data.json` — bulk parts `[{supplierCode, partNo, wclItemNo, description, defaultCoo}]` (dedup keep-first; COO `--` → null) + supplier code list. JSON (not TS) to keep the repo diff/tooling sane at ~100k rows; loaded via `fs.readFileSync(new URL(..., import.meta.url))`.
- `apps/backend/src/db/seed-net-weight-data.ts` — `[{partNo, weight}]` grams (qty=1), only parts that exist after the parts mapping, deduped.
- `apps/backend/src/db/seed-order-210726.ts` — order/invoices/items arrays in the `seed-real-data.ts` style (fixed UUIDs from the `…3000+` range). Items: `partNo` = split+strip of `Our P/No.`, `wclItemNo` verbatim, `poNo`, `lineQty`, `ctnNo = C/No.`, `coo = 產地` verbatim; invoice: `supplierId` resolved at seed time by brand code, `wclCompanyName = OFFICE NAME`, `totalCtn` = distinct C/No count, `totalQty` = Σ qty; generator warns/skips any item whose part_no is missing from the parts map.

### 6. Seed wiring (`apps/backend/src/db/seed.ts`)
- Sub-inventories: insert generated 151 rows + self-tags **in addition to** the existing demo groups/tags (ACME-S1, 140/143 STORE1 groups, DEFAULT, etc. — needed by `LEGACY_TAG_GROUPS` and current seed rows; no PK collisions since names differ).
- Suppliers: keep uid(3/4/28); auto-create rows for all generated prefixes not already present (randomUUID ids).
- Parts: insert demo parts uid(5..9) first, then bulk JSON in chunks of ~2000 with `onConflictDoNothing()` on part_no, then `realParts` with `onConflictDoNothing()`.
- Weight: replace the 2 hand-written `netWeightFormula` rows with generated rows (randomUUID ids, chunked).
- 210726: insert generated order/invoices/items (invoice `supplierId` resolved via a `code → id` map built after supplier inserts).
- Share-group demo seed: `{ orgId: 2, code: "STORE1", shareGroup: "HK" }` + `{ orgId: 2, code: "WSTORE1", shareGroup: "HK" }`.
- `seedAll(db, opts)` gains `bulkParts?: boolean` (default true); `test-helper.ts` passes `bulkParts: false` (tests keep the small world); `seedIfEmpty`/`db:seed` use the full set.
- Priority-seq UPDATE at the end unchanged.

### 7. Admin parts server-side paging
- Backend `routes/admin/crud.ts`: optional `CrudConfig.search?: (q: string) => SQL`; in `GET /`, when `?page=`/`?pageSize=`/`?q=` present, return `{ rows, total }` with LIMIT/OFFSET + COUNT (default path unchanged for other entities). Wire `search` for parts (`partNo`/`wclItemNo`/`description` ILIKE) in `routes/admin/index.ts`.
- Admin `components/CrudTable.vue` + `utils/entities.ts`: entity flag `serverPaging: true` on parts → fetch `/admin/parts?page=&pageSize=&q=`, drive `Pager.vue` from server `total`, add a search box; other entities keep client-side `usePaging`.

### 8. Docs
- `docs/backend/schema-tables.md`: `sub_inventory_share_members` entry.
- `docs/backend/README.md`: route catalog += share-group routes.
- `AGENTS.md`: update sub-inventory model paragraph (real 13-org master, share members), seed description (parts bulk, 210726 order, generator script), admin paging note.
- `docs/app-docs/ai/feature-registry.md` + `code-map.md` + picking/receiving `ai-scope.md`: share groups, new seed order, generator.

### 9. Verify
1. `docker compose up -d`; `pnpm --filter @warehouse/backend db:generate` (migration committed).
2. `pnpm --filter @warehouse/backend db:seed` — completes; spot-check counts (`SELECT count(*) FROM parts` ≈ 100k + demo; 151+ sub-inventories; 107 invoices for 210726).
3. `pnpm --filter @warehouse/backend test` and `build`.
4. `pnpm --filter @warehouse/admin build`; manual admin check: parts search/paging, sub-inventory share-group edit.
5. Manual allocate check: `POST /dev/allocate` with a demo demand naming STORE1 pulling from WSTORE1 stock via the demo share group.

## Notes / risks
- Bulk parts make `db:seed` slower (chunked inserts; acceptable one-shot cost) — tests unaffected via `bulkParts: false`.
- `KOA+TCG` supplier stays for the QR-template supplier profile even though new parts use `KOA`.
- 210726 `產地` values are Chinese text （中國…) stored verbatim in `coo` (free-text column).
