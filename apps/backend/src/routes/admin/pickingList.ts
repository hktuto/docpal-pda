import { Hono } from "hono";
import { db } from "../../db.js";
import { loadPickingListDocument } from "../../export/picking-list/data.js";
import "../../export/picking-list/render/default.js"; // registers the default renderer
import { resolveRenderer } from "../../export/registry.js";
import type { PickingListDocument } from "../../export/picking-list/model.js";

// Admin picking-list download (spec
// docs/superpowers/specs/2026-09-14-admin-picking-list-download-design.md;
// mirrors the receiving shipper, 2026-09-14-admin-receiving-shipper-download-design.md):
// a flat one-row-per-allocation xlsx telling the picker, per item, where to
// get the allocated stock (shelf / box / lot) or which receiving order it is
// coming from (dock pick). Items sharing a part number are merged into ONE
// block (summed qtys, allocation rows from all lines), and allocations from
// the same location + date code + COO merge into one row with a summed qty.
// Read-only — no in-request recompute; the detail page has an explicit
// Reallocate action.
// Data assembly and layout live in src/export/picking-list/ (spec
// 2026-09-21-admin-excel-export-renderer-separation-design.md); this route
// is HTTP plumbing only.

export const adminPickingListRoute = new Hono();

adminPickingListRoute.get("/picking-orders/:id/picking-list", async (c) => {
  const doc = await loadPickingListDocument(db, c.req.param("id"));
  const renderer = resolveRenderer<PickingListDocument>("picking-list", {
    customerCode: doc.head.customerCode,
  });
  const { fileName, buffer } = renderer.render(doc);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Length": String(buffer.length),
    },
  });
});
