# Picking transfer orders: from_subinventory → org conversion — design

Date: 2026-09-03
Status: implemented

## Problem

Some upstream picking orders are **transfers**: `picking_orders.org_id` /
`sub_inventory_code` name the DESTINATION, not the source of the stock
(example live order `GZ-26080231`: pair `14 / GZSZ`, i.e. ship-to Shenzhen).
These items carry the real source in `picking_items.additional_data`:

```json
{ "to_subinventory": "GZSZ", "from_subinventory": "GZHK2" }
```

Allocation matches sources on the order's `(org_id, sub_inventory_code)` pair,
so transfer demands never match — there is no stock at the destination. The
`from_subinventory` code alone is also not enough: codes are not globally
unique (`GZHK2` exists under org 9 AND org 14 in `org_info`), so the code →
org mapping is per-warehouse business data, not derivable.

## Decisions

- **Configurable in the flow config**, not hardcoded: new top-level key
  `pickingFromSubinventoryOrgs` in the `warehouse_config` row `"flow"` (same
  pipeline as `receivingSubInventoryRules` — `FLOW_CONFIG` env override wins,
  admin `PUT /admin/flow-config` applies at runtime, admin console edits it
  on the Flow Config page).
- **Two-step conversion, applied inside `allocateAll`** (`resolveDemandLocation`
  in `src/db/allocate.ts`), per demand row:
  1. `org_id` ← the group whose `fromSubinventories` lists the item's
     `additional_data.from_subinventory` (exact, case-sensitive).
  2. `sub_inventory_code` ← the **same `receivingSubInventoryRules`** used at
     receiving confirm-arrival, evaluated with the parent picking order's
     `po_no` under the converted org (`matchSubInventoryRule`). No
     receiving-rule match → the `from_subinventory` code itself.
- **Leave-as-is fallback**: an item with no `from_subinventory`, or whose
  code is in no group, keeps the order's pair — today's behavior. Nothing is
  skipped or surfaced; an unmatched transfer simply allocates from the
  destination pair as before (usually nothing).
- **Pure lookup — no write-back.** The converted pair only lives inside the
  allocation run; `picking_items` / `picking_orders` rows are never rewritten,
  keeping the recompute idempotent and write-light.
- The conversion feeds BOTH source kinds (shelf lots and in-hand receiving
  stock) because it rewrites the demand's pair before `loadLotSources` /
  `loadReceivingSources` run; share-group widening still applies on top.
- Duplicate `from_subinventory` codes across groups are rejected at config
  validation (ambiguous mapping = config error).

## Config shape

Grouped by target org (mirrors how the business states the rule):

```json
"pickingFromSubinventoryOrgs": [
  { "orgId": 143, "fromSubinventories": ["SZHK2", "GZHK2", "SHHK2", "BJHK2"] },
  { "orgId": 220, "fromSubinventories": ["THHK2"] },
  { "orgId": 140, "fromSubinventories": ["HUAWEI", "ZTE", "SZHK1", "GZHK1", "SHHK1", "BJHK1"] },
  { "orgId": 2,   "fromSubinventories": ["WSTORE1", "STORE1"] }
]
```

Worked example (order `GZ-26080231`, item `from_subinventory = GZHK2`, order
`po_no = 329…`, receiving rules `329* → GZHK2` under orgs `[140,143,120]`):
converted pair = `(143, GZHK2)` → allocation matches receiving stock stamped
`GZHK2` at confirm-arrival, closing the receiving → transfer-picking loop.

## Interaction with receivingSubInventoryRules

The two keys are one pipeline: receiving rules stamp the SOURCE side
(receiving items at confirm-arrival), `pickingFromSubinventoryOrgs` +
the same receiving rules resolve the DEMAND side (transfer picking items at
allocation). Keeping one rule set for the sub-inventory mapping means the
`319* → SZHK2` style patterns are maintained once.
