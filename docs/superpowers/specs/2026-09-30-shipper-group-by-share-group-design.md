# Shipper export: group sections by sub-inventory share group — design

Date: 2026-09-30
Status: implemented
Plan: `docs/superpowers/plans/2026-09-30-shipper-group-by-share-group.md`
Builds on: 2026-09-21-shipper-split-by-location-design.md
(spec `docs/superpowers/specs/2026-09-21-shipper-split-by-location-design.md`)

## Problem

The admin shipper download (`GET /admin/receiving-orders/:id/shipper`,
live + `?mode=finished`) splits the output into one xlsx per
`(org_id, sub_inventory_code)` pair of the order's invoice items
(`loadShipperDocuments`, `src/export/shipper/data.ts`). Sub-inventories
that share stock via `sub_inventory_share_members` (same `share_group`)
are served by the same allocation pool — `allocate.ts` widens the
sub-inventory match to sibling group members — but the export still
emits one file per raw sub-inventory code, so one physical team can
receive several files for what allocation treats as one location.

## Goals

1. Items whose `(org_id, sub_inventory_code)` belongs to a
   `sub_inventory_share_members` group merge into **one section / one
   xlsx**, so the file split matches the allocation location pool.
2. Slot attribution (whole-order, package, related-allocated rows)
   understands group membership: a slot whose picking-order / lot pair
   is a sibling member of the section's group lands in that section.
3. Orders with no share-group involvement produce byte-identical output
   to today.

## Non-goals

- Splitting the picking-list export.
- Any schema or admin-UI change (share groups stay managed at
  `/admin/sub-inventory-share-groups`).
- Re-stamping item `sub_inventory_code` values (the export remains
  read-only; this spec only changes how rows are bucketed for output).
- A `?group=` opt-out flag: grouping becomes the only mode, consistent
  with split-by-location being the only mode.

## Decisions

- **Group key = the `share_group` string, exactly mirroring allocation.**
  `allocate.ts` (`loadLotSources` / `loadReceivingSources`) widens the
  match with `sm_d.share_group = sm_s.share_group` and nothing else, so
  two members in *different orgs* sharing one group code already serve
  each other today. The export uses the same rule: items group together
  when their pairs resolve to the same `share_group` string, cross-org
  included. (In practice warehouses use per-org group names, e.g. `HK`;
  the export then behaves org-scoped anyway.) Membership lookup is
  **case-insensitive on the sub-inventory code** (`upper()`, per
  allocate.ts) and exact on `org_id`.

- **Section identity = the representative member.** A group section
  keeps the `(orgId, subInventoryCode)` of the first member present in
  the order's items, in section order (`orgId` asc, code asc,
  NULLS LAST). The route's file naming
  (`shipper-<batchNo>-org<orgId>-<subInv>.xlsx`,
  `src/routes/admin/receivingShipper.ts:68-72`) is unchanged — it just
  consumes the representative pair. Alternative considered: naming by
  `share_group` code; rejected — the org/code pair stays consistent with
  the existing name shape and stays unambiguous when group names repeat
  across orgs.

- **Non-member items are untouched.** An item whose pair matches no
  `sub_inventory_share_members` row (including NULL
  `sub_inventory_code`, which can never be a member) forms its own
  section keyed by its raw pair, exactly as today.

- **Slot attribution widens to group equivalence.**
  `loadShipperDocuments`'s `pairMatches` (`data.ts:513-515`) currently
  requires pair equality (case-insensitive code compare). It becomes:
  pairs match when equal as today, **or** when both resolve to the same
  `share_group` string. This covers all three slot sources uniformly:
  - *Whole-order allocations* — the picking order's pair vs the
    section's representative pair (e.g. a demand on `HK-B` whose source
    is this order's `HK-A` item, `HK-A`/`HK-B` in group `HK`, now
    attributes into the merged `HK` section instead of falling back).
  - *Finished-mode package slots* — same, via the picking order's pair.
  - *Related-allocated rows* — the source lot's own pair vs the section.
  The existing fallback (part's first section in section order) stays
  for slots that match no candidate's pair/group.

- **Section ordering and per-section values.**
  Sections sort by representative pair (`orgId` asc, code asc, NULLS
  LAST), replacing the raw-pair sort. Per-section `Total Ctn` stays the
  count of DISTINCT non-null `ctn_no` across the merged section's items.
  Item order inside a section is the query's part/PO/ctn order
  (unchanged). `slotCount` and block layout are recomputed per merged
  section by the existing `buildShipperDocument` — renderers need no
  changes.

- **Single/multi-section HTTP behavior is unchanged.** One section →
  plain xlsx under the renderer's own file name; more than one → zip of
  per-section files; zero items → combined fallback document
  (`loadShipperDocument`).

## Implementation sketch

`src/export/shipper/data.ts` `loadShipperDocuments`:

1. After loading items, load the share-group map once:
   `SELECT org_id, upper(code) AS code, share_group FROM
   sub_inventory_share_members` → `Map<"${orgId}::${code}", shareGroup>`.
2. Section key for an item: if its pair resolves to a group, key on
   `group:${shareGroup}`; otherwise key on the raw
   `${orgId}::${subInventoryCode?.toLowerCase() ?? ""}` as today. The
   section stores the representative pair (first member inserted, with
   sections re-sorted by representative pair afterwards).
3. `pairMatches(a, s)`: true on existing equal-pair test, or when both
   `a`'s pair and `s`'s pair resolve to the same group.
4. Everything downstream (`attribute`, per-section doc build, route
   naming) is untouched.

## Testing

Additions to `apps/backend/src/routes/admin/receivingShipper.test.ts`:

1. Items in two sub-inventories of the same share group → **one** plain
   xlsx (not a zip), file name using the representative pair; sheet
   contains both items' rows.
2. Items across two different share groups → zip with one xlsx per
   group, names per representative pairs.
3. Mixed: grouped items + an ungrouped sub-inventory + a NULL
   `sub_inventory_code` item → sections in representative-pair order
   (orgId asc, code asc — a NULL code sorts last within its org).
4. Whole-order allocation whose picking-order pair is a *sibling* member
   of the item's group lands in the merged section (no fallback to
   first-section).
5. Related-allocated row attributed by a lot whose pair is a sibling
   member of the section's group.
6. Case-insensitivity: item code `Store1` matches member `STORE1`.
7. No share-group rows in the DB at all → byte-identical output to
   today's split (existing tests pin this).
8. `?mode=finished` package-slot attribution through a sibling member.

## Documentation

On implementation: `docs/backend/api-design.md` (shipper route
response — section = share group), shipper entries in
`docs/app-docs/flows/receiving/ai-scope.md` and
`docs/app-docs/ai/feature-registry.md`.
