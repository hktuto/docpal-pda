# Receiving sub-inventory defaulting rules — design

Date: 2026-09-02
Status: implemented

## Problem

Upstream receiving sync often leaves `receiving_invoice_items.sub_inventory_code`
NULL. Allocation matches sources on the `(org_id, sub_inventory_code)` pair, so
pair-less receiving items are skipped (`skippedReceivingSources` in
`allocateAll`) and freshly confirmed stock never reaches picking demand. The
business rule for filling the gap is known — by item `org_id` + `po_no` prefix —
but it is per-warehouse data, not code.

## Decisions

- **Configurable in the flow config**, not hardcoded: new top-level key
  `receivingSubInventoryRules` in the `warehouse_config` row `"flow"` (same
  pipeline as `allowedOrgIds` — `FLOW_CONFIG` env override wins, admin
  `PUT /admin/flow-config` applies at runtime, admin console edits it on the
  Flow Config page).
- **Applied at confirm-arrival** (`confirmReceivingArrival`), inside the same
  transaction, before the caller schedules the async allocation recompute —
  so allocation always sees the stamped pairs. Ingest is deliberately NOT
  touched: items stay unlabeled until the order is confirmed.
- **Recompute semantics**: every item of the order that a rule matches is
  (re)stamped, overwriting any upstream-supplied value. Items matched by no
  rule keep their value.
- **Only `sub_inventory_code` is written — `org_id` is never rewritten.**
  Cross-org supply is handled by `sub_inventory_share_members`, not by
  rewriting partitions.
- No existence check of the stamped code against `org_info` — free-form text,
  consistent with the rest of the flow config. (The composite FK means an
  unknown `(org_id, code)` pair fails the confirm-arrival tx loudly, which is
  the desired signal that the rule/config is wrong.)

## Config shape

Rules are **grouped by org set** (2026-09-02, revised same day): each group
carries the org_ids it applies to, an ordered pattern list, and an explicit
default — so orgs that share a mapping (e.g. 140/143/120) are configured once.

```json
"receivingSubInventoryRules": [
  { "orgIds": [140, 143, 120],
    "patterns": [
      { "poNoPattern": "319*", "subInventoryCode": "SZHK2" },
      { "poNoPattern": "329*", "subInventoryCode": "GZHK2" },
      { "poNoPattern": "339*", "subInventoryCode": "SHHK2" },
      { "poNoPattern": "349*", "subInventoryCode": "BJHK2" },
      { "poNoPattern": "11*W", "subInventoryCode": "ITSTORE1" }
    ],
    "default": "STORE1" }
]
```

- An item enters the **first group whose `orgIds` contains its org_id**;
  groups for other orgs (and later groups for the same org) are skipped.
- Inside the group, patterns are tried in order — **first match wins**. The
  `poNoPattern` is a **glob**: `*` matches any run of characters, every other
  character is literal — `319*` prefix, `*W` suffix, `11*W` prefix+suffix,
  `*` catch-all. A NULL `po_no` is matched as `""`. Full-string,
  case-sensitive.
- When no pattern matches, the group's **`default`** is stamped
  (`null`/absent = leave the item unchanged). Items whose org is in no group
  keep their value.
- Legacy stored shapes are normalized at load: a flat
  `{orgIds, poNoPattern, subInventoryCode}` rule becomes a single-pattern
  group with `default: null`; the oldest `poNoPrefix` form maps to the glob
  `prefix + "*"` (`""` → `"*"`).
- Default `[]` = feature off.

## Implementation

- `apps/backend/src/config.ts` — `SubInventoryRuleGroup` /
  `SubInventoryPatternRule` types, key validation in `mergeFlowConfigJson`
  (with legacy-shape normalization), `receivingSubInventoryRules()` getter.
- `apps/backend/src/db/receiving.ts` — `poNoGlobTest` (glob → anchored RegExp,
  regex chars escaped) and pure `matchSubInventoryRule(orgId, poNo, groups)`;
  `confirmReceivingArrival` groups the order's items by the resulting code and
  runs one UPDATE per distinct code.
- Admin: `routes/admin/flowConfig.ts` needed no change (the key passes through
  the existing validate/persist/apply pipeline); the console's Flow Config
  page (`apps/admin/pages/flow-config.vue`) gained a grouped rule editor
  (org group → pattern rows + default).
