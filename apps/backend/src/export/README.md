# Admin Excel exports (`src/export/`)

The admin Excel downloads (shipper, picking list) are split into three
layers (spec:
`docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md`):

```
export/
  registry.ts            # registerRenderer / resolveRenderer + fallback chain
  shipper/
    data.ts              # SQL + grouping → ShipperDocument (no XLSX types)
    model.ts             # plain document types
    render/default.ts    # ShipperDocument → xlsx buffer (self-registers)
  picking-list/          # same shape
```

Routes (`src/routes/admin/receivingShipper.ts`, `pickingList.ts`) are HTTP
plumbing only: load the document, resolve a renderer, return the file.

## Adding a new layout (per supplier / customer / warehouse)

A "layout" = a new **renderer**. You never fork the data assembly — every
renderer receives the same document model.

**Config-style variant (preferred when the difference is just labels / field
choices):** see the real example `shipper/render/hcc.ts` — it reuses the
default layout through the `makeShipperRenderer(options)` factory and only
overrides the first column's header + field:

```ts
import { registerRenderer } from "../../registry.js";
import { makeShipperRenderer } from "./default.js";

registerRenderer(
  "shipper",
  makeShipperRenderer({ firstColumnHeader: "Drawing No / CTN", firstColumnField: "drawingNo" }),
  { supplierCode: "23" }
);
```

**Structurally different layout:** create `export/<doc>/render/<name>.ts`:

```ts
import { registerRenderer } from "../../registry.js";
import type { ShipperDocument } from "../model.js";

function render(doc: ShipperDocument): { fileName: string; buffer: Buffer } {
  // build the sheet from doc — reuse helpers from ./default.js where possible
  return { fileName: `shipper-${doc.head.batchNo}.xlsx`, buffer };
}

registerRenderer("shipper", { render }, { supplierCode: "XYZ" });
```

Either way, import it for the registration side effect, next to the default
import in the route (`src/routes/admin/receivingShipper.ts`):

```ts
import "../../export/shipper/render/default.js";  // default renderer
import "../../export/shipper/render/hcc.js";      // supplier 23 (HCC) variant
```

**Resolution order** (first match wins): scoped registration whose **all**
declared scope keys equal the document's values → the unscoped default.
Scope keys: `supplierCode` (shipper, from the receiving order),
`customerCode` (picking list, from the picking order). `warehouse` is
reserved but unwired — `warehouse_config` has no warehouse identifier
yet; add one (config row or env) when the first warehouse-scoped variant
is needed.

Rules:

- **Config before forks.** If the difference is just labels / column order /
  widths / field visibility, prefer one renderer + per-scope config over a
  new renderer (the template-library spec will cover this).
- **Share render helpers.** A variant should import block/header writers
  from `./default.js` and differ only where it must; fully independent
  renderers only for structurally different documents.
- **Never fork `data.ts`.** If a layout needs a field the model doesn't
  have, add it to the shared document model — every renderer benefits.

## Template-backed renderers (planned)

A templating library (ExcelJS-as-base / xlsx-template / carbone) is still
under evaluation. When chosen, a template-backed renderer is just another
`Renderer` implementation registered here — routes and data assembly stay
untouched.
