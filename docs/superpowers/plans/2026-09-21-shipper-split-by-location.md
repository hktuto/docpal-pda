# Shipper split by location — implementation plan

Date: 2026-09-21
Spec: docs/superpowers/specs/2026-09-21-shipper-split-by-location-design.md

## Steps

1. **Add `fflate` to `apps/backend`** (`pnpm --filter @warehouse/backend add fflate`).
   Used only for `zipSync` in the shipper route.

2. **`apps/backend/src/export/shipper/data.ts`** — add split assembly:
   - Item query already selects `orgId`/`subInventoryCode` (lines 105-106).
   - `orderAllocs` query (live) and `packageAllocs` query (finished): add
     `po.org_id AS "orgId"`, `po.sub_inventory_code AS "subInventoryCode"`
     to SELECT and GROUP BY.
   - `relatedAllocs` query: add the same two columns (GROUP BY too).
   - Extract the existing body of `loadShipperDocument` into a shared
     internal builder that takes an item-filter predicate, OR keep
     `loadShipperDocument` as-is and add `loadShipperDocuments(db, id,
     { finished })` that:
     - runs the same queries once,
     - partitions items by `(orgId, subInventoryCode)` — NULL sub-inv
       section key `null`, sections ordered by orgId then
       subInventoryCode (NULLS LAST),
     - per section: filters items/groups, attributes slots:
       - item-level: `allocsByItem` follows the item (already per-item);
       - order-level / package slots: picking-order pair matches section
         pair (case-insensitive sub-inv); fallback → the section holding
         the slot's part group, first in section order;
       - relatedAllocs: same pair rule, same fallback;
     - recomputes `slotCount` per section (same widest-block logic,
       scoped to the section's groups);
     - returns `{ section: { orgId, subInventoryCode }, doc }[]`.
   - `loadShipperDocument` must produce byte-identical output to today —
     implement it as "build everything, merge all sections" or keep its
     code path untouched; existing tests pin this.

3. **`apps/backend/src/routes/admin/receivingShipper.ts`**:
   - Parse `split=location` query param.
   - Non-split: unchanged.
   - Split: `loadShipperDocuments`, render each section via
     `resolveRenderer` (per-section file name from section key:
     `shipper-<batchNo>-org<orgId>-<subInv|no-subinventory>.xlsx`,
     sanitize `/\:*?"<>|` and whitespace runs → `-`; finished prefix
     `finished-shipper-`).
   - One section → return the single xlsx as today (per-section name).
   - >1 sections → `zipSync` members → `Content-Type: application/zip`,
     `Content-Disposition` `shipper-<batchNo>.zip` /
     `finished-shipper-<batchNo>.zip`.

4. **Admin UI `apps/admin/pages/receiving/[id].vue`**:
   - `downloadShipper(finished, split)` — appends `&split=location`;
     read filename from `Content-Disposition` header
     (`filename*=UTF-8''...`), fallback to current hardcoded name.
   - Two new buttons next to the existing ones, same status gating
     (`in_hand` live split, `clear` finished split).

5. **i18n** — add `admin.pages.receiving.downloadShipperSplit` and
   `downloadFinishedShipperSplit` to
   `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` (mirror the existing
   `downloadShipper` entries).

6. **Tests** — extend
   `apps/backend/src/routes/admin/receivingShipper.test.ts` per spec §Testing
   (zip with two members + contents, item-level slot isolation,
   whole-order attribution + fallback, NULL sub-inv section,
   single-section plain xlsx, finished-mode split). Parse zip members in
   tests with `fflate unzipSync`; parse member xlsx with `XLSX.read`.

7. **Docs**:
   - `docs/backend/api-design.md` — shipper route: `split=location`
     param + zip response.
   - `docs/app-docs/flows/receiving/ai-scope.md` — shipper split behavior.
   - `docs/app-docs/ai/feature-registry.md` — update shipper entry if it
     lists files/behavior.
   - `AGENTS.md` — one sentence on the shipper split under the admin
     export/shipper mention if a suitable bullet exists (only if it
     documents shipper today — check first).

## Verification

1. `docker compose up -d` (Postgres for tests).
2. `pnpm --filter @warehouse/backend build` (tsc).
3. `pnpm --filter @warehouse/backend test` — full suite green,
   especially `receivingShipper.test.ts` and `registry.test.ts`.
4. `pnpm --filter @warehouse/web nuxt prepare` — not affected (backend +
   admin only); run `pnpm --filter @warehouse/admin nuxt prepare` if it
   exists, else skip.
5. Manual smoke (optional if tests cover): start backend, download
   split shipper for a multi-location demo order.

## Commit

Single commit: `feat(backend,admin): split shipper download by org/sub-inventory location`.

## Addendum (2026-09-21, follow-up change)

- Split became the ONLY mode: the route no longer reads `split`, the
  combined download and its buttons/i18n keys were removed, and a
  single-section order returns the plain xlsx under the renderer's own
  file name (no `-org<id>-<subInv>` suffix).
- CORS fix: `exposeHeaders: ["Content-Disposition"]` in
  `apps/backend/src/index.ts` — without it the cross-origin admin SPA
  could not read the header and saved zips under an `.xlsx` name.
