# Transfer allocation: item-level order_no / po_no rule reference — design

Date: 2026-09-07
Status: implemented
Amends: `2026-09-03-picking-from-subinventory-orgs-design.md`

## Problem

The 2026-09-03 transfer conversion resolves the allocation sub-inventory by
evaluating `receivingSubInventoryRules` with the **parent picking order's**
`po_no`. Upstream picking items do not reliably carry that reference at order
level — instead, upstream now stamps the reference **per item** in
`picking_items.additional_data` as either `order_no` or `po_no`.

## Decision

`resolveDemandLocation` (`src/db/allocate.ts`) computes the rule reference
from the item's `additional_data`, in this order:

1. `additional_data.order_no` — when set (non-blank), it wins;
2. else `additional_data.po_no`;
3. else null — no `poNoPattern` glob matches an empty reference (except a
   literal `*` catch-all), so the rule **group's `default`** applies.

The result then flows through the existing chain unchanged: matched pattern →
its `subInventoryCode`; no match → group `default`; `default` null (or no
group for the converted org) → the `from_subinventory` code itself.

The parent order's `po_no` is **no longer consulted** — the item-level values
replace it (upstream owns stamping them). Blank/whitespace values count as
unset.

## Scope

- Pure allocation-time lookup; nothing is written back to `picking_items`.
- Only transfer items (`additional_data.from_subinventory` present and listed
  in a `pickingFromSubinventoryOrgs` group) are affected; all other demands
  keep the order's pair.
- Config shape is unchanged — no new flow-config keys.
