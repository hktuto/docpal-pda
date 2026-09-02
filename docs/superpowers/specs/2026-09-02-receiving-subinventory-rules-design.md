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

```json
"receivingSubInventoryRules": [
  { "orgIds": [140, 143, 120], "poNoPattern": "319*", "subInventoryCode": "SZHK2" },
  { "orgIds": [140, 143, 120], "poNoPattern": "329*", "subInventoryCode": "GZHK2" },
  { "orgIds": [140, 143, 120], "poNoPattern": "339*", "subInventoryCode": "SHHK2" },
  { "orgIds": [140, 143, 120], "poNoPattern": "349*", "subInventoryCode": "BJHK2" },
  { "orgIds": [140, 143, 120], "poNoPattern": "11*W", "subInventoryCode": "ITSTORE1" },
  { "orgIds": [140, 143, 120], "poNoPattern": "*",    "subInventoryCode": "STORE1" }
]
```

- Ordered; **first match wins**.
- An item matches when `item.org_id ∈ orgIds` AND its `po_no` matches the
  `poNoPattern` **glob**: `*` matches any run of characters, every other
  character is literal — `319*` prefix, `*W` suffix, `11*W` prefix+suffix,
  `*` catch-all (also matches a NULL `po_no`, which is matched as `""`).
  Full-string, case-sensitive.
- A legacy rule stored with `poNoPrefix` (the initial 2026-09-02 shape) is
  normalized at load to the glob `prefix + "*"` (`""` → `"*"`).
- Default `[]` = feature off.

## Implementation

- `apps/backend/src/config.ts` — `SubInventoryRule` type, key validation in
  `mergeFlowConfigJson` (`orgIds` non-empty int array, `poNoPattern` non-empty
  glob string, `subInventoryCode` non-empty), `receivingSubInventoryRules()`
  getter.
- `apps/backend/src/db/receiving.ts` — `poNoGlobTest` (glob → anchored RegExp,
  regex chars escaped) and pure `matchSubInventoryRule(orgId, poNo, rules)`;
  `confirmReceivingArrival` groups the order's items by the resulting code and
  runs one UPDATE per distinct code.
- Admin: `routes/admin/flowConfig.ts` needed no change (the key passes through
  the existing validate/persist/apply pipeline); the console's Flow Config
  page (`apps/admin/pages/flow-config.vue`) gained a rule-list editor.
