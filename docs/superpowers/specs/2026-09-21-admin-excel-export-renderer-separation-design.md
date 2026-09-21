# Admin Excel export: data/renderer separation — design

Date: 2026-09-21
Status: proposed
Builds on: 2026-09-14-admin-receiving-shipper-download-design.md,
2026-09-14-admin-picking-list-download-design.md,
2026-09-16-admin-receiving-shipper-related-allocated-design.md

## Problem

The two admin Excel downloads hardcode their sheet layout inside the route
files:

- `apps/backend/src/routes/admin/receivingShipper.ts` — shipper (live +
  `?mode=finished`): ~250 lines of queries/grouping followed by ~150 lines
  of `aoa` row-building, column widths and `XLSX.write`.
- `apps/backend/src/routes/admin/pickingList.ts` — picking list: same
  shape, smaller.

The deployment needs to support multiple warehouses, and some warehouses —
or specific suppliers (shipper) / customers (picking list) — need a
*different layout* of the same document. Today that means editing the route
code and redeploying one global layout. A templating library
(ExcelJS-as-base / xlsx-template / carbone) is under consideration but not
yet decided; the separation in this spec is a prerequisite under every
candidate and is valuable on its own.

## Goals

1. Split each export into three layers: **data assembly** (queries +
   grouping/merging, no XLSX types), a **document model** (plain TS data),
   and a **renderer** (document model → xlsx buffer).
2. A **renderer registry** that picks a renderer by document type + scope
   (warehouse / supplier / customer) with a fallback chain, so variant
   layouts register without touching the routes.
3. **Zero behavior change**: the existing route tests
   (`receivingShipper.test.ts`, `pickingList.test.ts`) pass unmodified; the
   generated sheets are row-for-row identical to today.

## Non-goals

- Choosing or adopting a templating library (later spec; a template-based
   renderer becomes just another registry entry).
- Admin upload / DB storage of templates, or any admin UI.
- Any new layout variant — only the `default` renderer ships; the registry
  exists to make later variants possible.
- Changing the data assembly logic (SQL, grouping, slot computation) in any
  way beyond moving it.

## Decisions

- **Data assembly stays shared, always.** The SQL + grouping/merging/slot
  logic is the complex, bug-prone part and must never be forked per
  supplier/customer. Only the renderer varies. This is the core rule of the
  design; a variant renderer receives the same document model as default.

- **Document model = the semantic structure, not row geometry.** The model
  carries *what* the document says (head fields, part groups, slots,
  totals); the renderer decides *where* it lands (block heights, overlay
  rows, column order). The seam already exists in both files: everything
  before the `aoa` building is data assembly (`receivingShipper.ts:339`,
  `pickingList.ts:122`).

- **Renderer variants are the last resort, not the default.** Layout
  variation should be covered in this order: (1) one renderer + per-scope
  config (labels, widths, field visibility), (2) a variant renderer that
  reuses shared render helpers (block writer, header writer), (3) a fully
  independent renderer only when the document is structurally different.
  This spec ships the mechanism for (2)/(3); (1) arrives with the
  templating spec.

- **Keep SheetJS for the default renderer.** The refactor is
  library-neutral; `xlsx` stays the dependency until the templating
  decision lands.

- **Route stays thin and owns HTTP only**: params, 404s (thrown by data
  assembly), scope resolution, `Content-Disposition` headers. The renderer
  returns `{ fileName, buffer }`; the route wraps it in a `Response`.

## Module layout

```
apps/backend/src/export/
  registry.ts                 # renderer registration + scope resolution
  types.ts                    # RenderContext, Renderer interfaces
  shipper/
    data.ts                   # loadShipperDocument(db, id, { finished }) → ShipperDocument
    model.ts                  # ShipperDocument, ShipperGroup, ShipperSlot types
    render/default.ts         # current layout, moved verbatim
  picking-list/
    data.ts                   # loadPickingListDocument(db, id) → PickingListDocument
    model.ts                  # PickingListDocument, PickingListGroup, PickingListAlloc
    render/default.ts
```

Routes shrink to (shipper example):

```ts
adminReceivingShipperRoute.get("/receiving-orders/:id/shipper", async (c) => {
  const finished = c.req.query("mode") === "finished";
  const doc = await loadShipperDocument(db, c.req.param("id"), { finished }); // throws 404
  const renderer = resolveRenderer("shipper", { supplierCode: doc.head.supplierCode });
  const { fileName, buffer } = renderer.render(doc);
  return new Response(new Uint8Array(buffer), { headers: { ... } });
});
```

## Document models

### `ShipperDocument`

```ts
interface ShipperDocument {
  mode: "live" | "finished";
  head: {
    batchNo: string;
    supplierCode: string | null;
    supplierName: string | null;
    deliveryDate: string;        // yyyy-mm-dd or ""
    totalCtn: number | null;
  };
  slotCount: number;             // widest group's slot count (0 = no allocations)
  groups: ShipperGroup[];
}

interface ShipperGroup {
  partKey: string;               // COALESCE(wcl_item_no, part_no)
  blockItems: { invoiceCtn: string; qty: number }[];   // one per carton
  slots: ShipperSlot[];          // live: merged per-item slots; finished: package slots
  relatedAllocated: number;      // live mode only (0 in finished)
  totalQty: number;
  allocatedTotal: number;
  orderLevel: {                  // present only when whole-order allocations exist (live)
    slots: ShipperSlot[];
  } | null;
}

interface ShipperSlot {
  customer: string;              // label ?? code ?? order_no
  orderRef: string;              // order_no || po_no
  qty: number;
  prioritySeq: number;
  orderNo: string;
}
```

Everything the current `aoa` builder reads is captured: the default
renderer computes block heights, the last-three-rows overlay, the
related-allocated cell placement, the Total/Balance deferral to the
order-level closing block, and blank separators — from this model alone.

### `PickingListDocument`

```ts
interface PickingListDocument {
  head: {
    orderNo: string; poNo: string | null; customerCode: string | null;
    shipTo: string | null; orgId: number | null; subInventoryCode: string | null;
    status: string; allocationStatus: string; remark: string | null;
  };
  generatedAt: string;           // ISO timestamp, set by data assembly
  groups: PickingListGroup[];    // items already merged by part_no, first-seen order
}

interface PickingListGroup {
  partNo: string;
  qty: number; allocatedQty: number; pickedQty: number;
  allocs: PickingListAlloc[];    // already merged by location/date-code/COO key
}

type PickingListAlloc =
  | { kind: "lot"; shelfCode: string | null; boxId: string | null;
      dateCode: string | null; lotCode: string | null;
      coo: string | null; cow: string | null;
      orgId: number | null; subInventoryCode: string | null; qty: number }
  | { kind: "receiving"; receivingBatchNo: string | null; qty: number };
```

The unallocated shortfall (`qty − Σ allocs.qty`) is **not** pre-baked into
the model — the renderer derives it, as today.

## Renderer registry

```ts
type ExportDocType = "shipper" | "picking-list";

interface RenderContext {
  warehouse?: string;            // deployment warehouse id (from warehouse_config)
  supplierCode?: string | null;  // shipper scope
  customerCode?: string | null;  // picking-list scope
}

interface Renderer<Doc> {
  render(doc: Doc): { fileName: string; buffer: Buffer };
}

registerRenderer(docType, renderer, scope?: { warehouse?; supplierCode?; customerCode? });
resolveRenderer(docType, ctx): Renderer;
```

Resolution order (most specific wins, first match returns):

1. scoped registration matching **all** its declared scope keys against the
   context (e.g. `{ supplierCode: "XYZ" }` matches only shipper docs for
   supplier XYZ);
2. warehouse-scoped registration (`{ warehouse }`);
3. the unscoped `default` renderer — always registered at module load, so
   resolution can never fail.

Both routes register their default renderer from their `render/default.ts`
module import; future variant renderers self-register the same way. The
warehouse id comes from the deployment's `warehouse_config` row (already
loaded at boot); scope keys come from the document head, so resolution
needs no extra queries.

## Testing

- **Acceptance**: `receivingShipper.test.ts` and `pickingList.test.ts`
  pass **unmodified** — they parse the xlsx back to rows and assert cell
  content, so they prove the refactor preserves output exactly.
- New unit test for `registry.ts`: scoped-beats-warehouse-beats-default
  resolution, including partial-scope mismatch (a registration declaring
  `supplierCode` must not match a context with a different supplier).
- No new HTTP-level tests: behavior is unchanged.

## Migration notes

- No schema, config, API or admin UI changes. Pure `apps/backend` code
  motion.
- After this lands, the templating-library spec only needs to: pick a
  library, add a template-backed renderer implementing `Renderer`, and
  decide template storage/scope — the routes and data assembly are
  untouched by that decision.
- `docs/app-docs` feature-registry/code-map updates happen with the
  implementation (file moves for the two routes' logic).
