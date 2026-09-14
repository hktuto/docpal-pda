# Sub-inventory share-group manager (admin console) — design

Date: 2026-09-14
Status: approved

## Background

Share groups (`sub_inventory_share_members`, spec
`2026-07-27-real-master-data-and-share-groups-design.md`) let sibling
sub-inventories serve each other's picking demands. The backend admin API
exists (`GET/PUT/DELETE /admin/sub-inventory-share-groups`,
`apps/backend/src/routes/admin/subInventoryShareGroups.ts`), and the admin
Sub-inventories page (`apps/admin/pages/sub-inventories.vue`) only offers a
per-row **free-text** share-group input. There is no group-centric view: you
cannot list groups, see a group's members, create one deliberately, or move a
member without retyping its name — and a typo silently creates a new group.

## Decision: UI-only group manager, no backend changes

`share_group` stays free text per member row — there is no groups table, so a
group exists only through its members (removing the last member deletes the
group). The existing endpoints already cover every operation:

- create group = PUT members with a new `shareGroup` name;
- add/move member = PUT upsert keyed on `(org_id, code)`;
- remove member = PUT with `shareGroup: null` (or DELETE);
- rename group = PUT all members with the new name.

Data volume is tiny (~150 sub-inventories, a handful of groups), so the admin
UI issues per-member calls; no bulk endpoint is warranted.

## UI changes on `apps/admin/pages/sub-inventories.vue`

1. **Table share-group cell becomes a select** — `—` (none) plus every existing
   group name; changing it immediately PUTs the row's membership. This removes
   the typo-creates-a-group failure mode.
2. **"Share groups" button** opens a management dialog:
   - Left pane: group list (name + member count), a new-group input, and a
     rename field for the selected group.
   - Right pane: org-grouped checkbox member picker built from the already-
     loaded sub-inventory rows, **keyed on `orgId:code`** (codes repeat across
     orgs; membership is per pair). Options show a badge when the sub-inventory
     currently belongs to a different group — checking it moves it.
   - Save diffs the selected group's member set and issues the per-member
     PUTs, then reloads the table.
   - A hint notes that a group saved with zero members does not persist.

## Edge cases

- Duplicate codes across orgs — picker keys on `orgId:code`, never code alone.
- One-group rule — moving is implicit (UNIQUE(org_id, code) upsert overwrites).
- Rename + member changes in one save are applied together.

## Out of scope

- No groups table, no bulk API, allocation semantics unchanged.
