# Shipper split by location (org_id + sub_inventory_code) — design

Date: 2026-09-21
Status: implemented (revised same day: split is the only mode)
Builds on: 2026-09-14-admin-receiving-shipper-download-design.md,
2026-09-16-admin-receiving-shipper-related-allocated-design.md,
2026-09-21-admin-excel-export-renderer-separation-design.md

## Problem

The admin shipper download (`GET /admin/receiving-orders/:id/shipper`,
live + `?mode=finished`) produces **one xlsx per receiving order**, with
receipts grouped by part key only. A receiving order can span multiple
stock partitions — `receiving_invoice_items.org_id` +
`sub_inventory_code` — and the warehouse wants one shipper file **per
location** so each sub-inventory team handles only its own cartons.

Two org_id columns exist and mean different things:
`receiving_invoices.org_id` is the *shipper's* office (sender);
`receiving_invoice_items.org_id` is the *receiving* office. The
receiving-office pair on the item is the stock-partitioning key that
allocation matches on, so it is the split key. The invoice-level org_id
is not used.

## Goals

1. Emit **one xlsx per `(org_id, sub_inventory_code)`
   group** of the order's invoice items, delivered as a single zip when
   more than one group exists.
2. Allocation slots attributed to the correct section, including
   whole-order (no `ctn_no`) allocations.
3. Per-section sheet rows are byte-for-byte what the former combined
   download showed for that section's items; renderers (`default`,
   `hcc`) need no changes.

## Non-goals

- Splitting by invoice, supplier, or shipper-office org_id.
- Changing the shipper layout or slot logic.
- Splitting the picking-list export.
- Editing `sub_inventory_code` from the admin UI (still not an editable
  field; `adminedits.ts` `RECEIVING_ITEM_FIELDS`).

## Timing background (why the data is reliable at download time)

`sub_inventory_code` is written at two moments:

1. **Row creation** by the external upstream sync — nullable, often
   omitted upstream.
2. **Confirm-arrival** (`confirmReceivingArrival`,
   `src/db/receiving.ts:140-162`) — re-stamped per the flow config
   `receivingSubInventoryRules` (item `org_id` picks the rule group,
   first `poNoPattern` glob wins, else group `default`; unmatched items
   keep their value), in the same tx, before allocation runs.

The admin shipper buttons are gated to `in_hand` / `clear` orders, i.e.
post-confirm-arrival, so split mode always sees the rule-stamped values.
Items matched by no rule may still carry NULL or an upstream value —
they form their own section (see below), they are not dropped.

## Decisions

- **Split is the only mode.** The route always splits by item
  `(org_id, sub_inventory_code)`; there is no `?split=` query param and no
  combined download (a stray `split` param is ignored). NULL
  `sub_inventory_code` is a real section labelled `(no sub-inventory)`;
  NULL `org_id` is impossible (NOT NULL, default 2).

- **Output = zip of per-section xlsx files.** One section → the plain
  xlsx is returned directly under the renderer's own file name
  (`shipper-<batchNo>.xlsx` / `finished-shipper-<batchNo>.xlsx`, no
  section suffix), so single-location orders see no change at all. Zip
  name: `shipper-<batchNo>.zip` / `finished-shipper-<batchNo>.zip`; member
  names: `shipper-<batchNo>-org<orgId>-<subInventoryCode>.xlsx` with
  filename-unsafe characters (`/\:*?"<>|` and whitespace runs) replaced
  by `-`, NULL → `no-subinventory`.

- **Zip library: `fflate`** (new backend dependency — tiny, ESM,
  dependency-free `zipSync`). No zip capability exists in the current
  backend deps (`xlsx` only). Store-level compression is acceptable —
  xlsx members are already deflate-compressed zip containers.

- **Data assembly produces N documents; renderers stay untouched.**
  `loadShipperDocument` keeps its signature and semantics (combined
  document). A new `loadShipperDocuments(db, id, { finished })` in
  `src/export/shipper/data.ts` shares the same queries and returns
  `{ section: { orgId, subInventoryCode }, doc: ShipperDocument }[]`,
  one entry per section, sections ordered by `orgId` then
  `subInventoryCode` (NULLS LAST). Each section's `ShipperDocument`
  reuses the existing model verbatim: same `head`, `groups` filtered to
  the section's items, `slotCount` recomputed per section (widest block
  within the section, not globally). The route maps each document
  through `resolveRenderer("shipper", { supplierCode })` as today — the
  HCC variant applies per file automatically.

- **Per-section Total Ctn.** The header `Total Ctn` is section-scoped:
  the count of DISTINCT non-null `ctn_no` among the section's items (the
  cartons physically in that section — invoice-level `total_ctn` can't be
  apportioned when one invoice spans sections). A section with no
  carton-numbered items renders blank (`null`), not a misleading 0. The
  zero-items fallback document keeps the original whole-order invoice
  sum. Per-group `Total Qty`/`Balance` were already section-scoped
  (groups are built from the section's items).

- **Per-carton allocation rows (live mode).** Allocations are per carton
  line (`allocations.receiving_invoice_item_id`), so each allocation gets
  its own column, sequential across the block in carton-concatenation
  order: the qty sits on its carton's row, the order ref directly above,
  the customer two cells above. Block height = carton count + 2 when any
  carton has slots (no slots → the original `max(items, 3)` shape);
  cartons stay bottom-aligned. Finished mode (package slots can't pin to
  cartons) and the whole-order closing block keep the pre-cascade overlay
  (all customers / all refs / all qtys on the block's last three rows).
  Supersedes the cascade decision below.

- ~~**Diagonal cascade slot layout (all blocks, live and finished).**~~
  SUPERSEDED (same day, against the user's hand-corrected file): the
  diagonal cascade misread the mockup — live allocations pin to their
  carton row, see the decision above.

- **Related-allocated cell shows source locations.** The bare number
  becomes a breakdown of the related orders' allocated qty per source
  location: `qty@shelf/box` entries joined `", "` — shelf NULL renders as
  `dock` (receiving/dock sources), box omitted when NULL (e.g.
  `15000@HK01-A-01/BOX-9, 4000@dock/CTN123`, `40000@dock`). Box =
  `COALESCE(inventory_lots.box_id, receiving_invoice_items.ctn_no)`; the
  per-group aggregation sums per (shelf, box), sorted qty desc then shelf
  then box. Applies to the single-section output too.
  **Exclusion:** allocations whose source traces back to THIS receiving
  order (own cartons / whole-order) are excluded — they are already
  visible as the block's slot columns. Stock lots stay even when
  lot-traced to this batch via `inventory_lot_sources` (once shelved they
  are stock), and dock sources from OTHER receiving orders stay. This
  refines the 2026-09-16 "any source" semantics.

- **Slot attribution to sections:**
  - *Item-level allocations* (live) follow their item — the item sits in
    exactly one section.
  - *Whole-order allocations* (live, `receiving_invoice_item_id IS NULL`)
    carry no location on the `allocations` row. Attribution uses the
    **picking order's `(org_id, sub_inventory_code)`** — allocate.ts
    matches demand to sources on that pair, so it identifies the source
    partition. The orderAllocs query gains `po.org_id`, `po.sub_inventory_code`;
    a slot lands in the section whose pair matches the order's pair
    (case-insensitive sub-inventory compare, mirroring allocate.ts), in
    the part group it already matches via the part-key rule. Fallback
    (share-group sources where the order's pair differs from the item's
    pair, or NULL pairs): the part's first section in section order.
  - *Finished mode* (`picking_packages`): same rule — the query already
    joins `picking_orders`; gain the same two columns, attribute per
    section, same fallback.
  - *Related-allocated qty* (live): the relatedAllocs query gains the
    picking order's pair; each section's group header counts only
    related allocations whose order pair matches the section (same
    fallback to the part's first section).

- **Route stays HTTP-only**: call the split loader, render each
  section, zip when >1, set `Content-Type: application/zip` and
  `Content-Disposition` accordingly. The CORS middleware exposes
  `Content-Disposition` (`exposeHeaders` in `src/index.ts`) so the
  cross-origin admin SPA can save the zip under its real name.

## Admin UI

`apps/admin/pages/receiving/[id].vue`:

- The existing shipper buttons are the only ones (split is the behavior);
  same status gating (`in_hand` → live, `clear` → finished).
- The saved file name is taken from the response's
  `Content-Disposition` header (falls back to the current hardcoded
  name) so the `.zip` extension survives.

## Testing

`apps/backend/src/routes/admin/receivingShipper.test.ts` additions:

1. Order with items in two `(org_id, sub_inventory_code)` pairs →
   `application/zip` containing exactly two
   xlsx members with the expected names; each member parses to the same
   rows the combined file would show for that section's items.
2. Item-level allocations land only in their item's section file.
3. Whole-order allocation attributed by the picking order's pair;
   fallback case (order pair matches no section) lands in the part's
   first section.
4. NULL `sub_inventory_code` items form the `(no sub-inventory)`
   section.
5. Single-section order → plain xlsx response (not zip), renderer's own
   file name.
6. `?mode=finished` — package slots attributed per
   section.
7. Single-section sheet rows identical to the former combined output
   (existing tests pin this).

## Documentation

On implementation: `docs/backend/api-design.md` (route params/response),
`docs/backend/schema-tables.md` not affected, shipper entries in
`docs/app-docs/flows/receiving/ai-scope.md` + `ai/feature-registry.md`.
