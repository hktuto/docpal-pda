# Shipper export: group sections by sub-inventory share group — plan

Spec: `docs/superpowers/specs/2026-09-30-shipper-group-by-share-group-design.md`
Date: 2026-09-30

## Key constraint discovered

The demo seed (`src/db/seed.ts:415-421`) declares `(2, STORE1)` + `(2, WSTORE1)`
as share group `HK`. The existing split tests use exactly those codes, so they
must explicitly remove share members after `reseed()` to keep covering raw
per-pair splitting; the new grouping tests add their own members.

## Steps

1. **`src/export/shipper/data.ts` — `loadShipperDocuments`:**
   - Load the share-group map once:
     `SELECT org_id, upper(code) AS code, share_group FROM sub_inventory_share_members`
     into `Map<"${orgId}::${code}", shareGroup>` (code already upper-cased).
   - Section key per item: pair resolves to a group → `group:<shareGroup>`;
     otherwise today's raw `${orgId}::${subInventoryCode?.toLowerCase() ?? ""}`.
   - Section stores the representative pair (first member inserted); after
     collection, sort sections by representative pair (orgId asc, code asc,
     NULLS LAST) — replaces the raw-pair sort.
   - Widen `pairMatches`: equal pairs (case-insensitive, as today) OR both
     pairs resolve to the same non-null share group.
   - Update the file-header comment (split-by-location → group-by-share-group).
   - `attribute()`, per-section doc build, route, renderers: untouched.

2. **Tests — `src/routes/admin/receivingShipper.test.ts`:**
   - Existing split tests (`PL-TEST-SP1/SP2/SP3`, finished split, plus
     `seedSplitScenario` callers): `DELETE FROM sub_inventory_share_members`
     right after `reseed()` so STORE1/WSTORE1 stay ungrouped.
   - New tests:
     a. Items in STORE1 + WSTORE1 (seeded group `HK`) → ONE plain xlsx named
        after the representative pair (`org2-STORE1`), containing both items;
        per-section Total Ctn counts distinct cartons across the merge.
     b. Two distinct groups + an ungrouped sub-inventory + a NULL
        sub_inventory_code item → zip with one member per section, ordered by
        representative pair, NULL last.
     c. Whole-order slot whose picking-order pair is a sibling member (demand
        on WSTORE1, order pair STORE1) attributes into the merged section.
     d. Related-allocated row attributed by a lot whose pair is a sibling
        member of the section's group.
     e. Case-insensitivity: item code `Store1` matches member `STORE1`.

3. **Docs:**
   - `docs/backend/api-design.md` — shipper route section split description.
   - `docs/app-docs/flows/receiving/ai-scope.md` + `ai/feature-registry.md` —
     shipper entries.
   - Spec status → implemented.

4. **Verify:** `pnpm --filter @warehouse/backend test` and
   `pnpm --filter @warehouse/backend build`.

## Out of scope

Route/renderers/schema/admin UI — unchanged per spec non-goals.
