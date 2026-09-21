import { Hono } from "hono";
import { db } from "../../db.js";
import { loadShipperDocument } from "../../export/shipper/data.js";
import "../../export/shipper/render/default.js"; // registers the default renderer
import "../../export/shipper/render/hcc.js"; // registers the supplier-23 (HCC) variant
import { resolveRenderer } from "../../export/registry.js";
import type { ShipperDocument } from "../../export/shipper/model.js";

// Admin shipper download (spec
// docs/superpowers/specs/2026-09-14-admin-receiving-shipper-download-design.md
// + 2026-09-16-admin-receiving-shipper-related-allocated-design.md;
// supersedes 2026-09-07-admin-receiving-picking-list-design.md):
// a shipper-style xlsx per receiving order — receipts grouped by part, each
// group one merged block: one item row per carton (`invoice_no ctn_no` |
// part | qty) with the slot rows (customer / order numbers / per-slot
// qtys) overlaid on the block's last three rows.
// Two modes (both read-only — re-allocation lives on
// POST /admin/receiving-orders/:id/reallocate):
//   default (?mode omitted): LIVE shipper for an in-hand order — slots come
//     from the current `allocations` table.
//   ?mode=finished: for a completed (`clear`) order — same layout, but slots
//     come from `picking_packages` (what was actually packed), because live
//     allocations are consumed/emptied once picking finishes.
// Data assembly and layout live in src/export/shipper/ (spec
// 2026-09-21-admin-excel-export-renderer-separation-design.md); this route
// is HTTP plumbing only.

export const adminReceivingShipperRoute = new Hono();

adminReceivingShipperRoute.get("/receiving-orders/:id/shipper", async (c) => {
  const finished = c.req.query("mode") === "finished";
  const doc = await loadShipperDocument(db, c.req.param("id"), { finished });
  const renderer = resolveRenderer<ShipperDocument>("shipper", { supplierCode: doc.head.supplierCode });
  const { fileName, buffer } = renderer.render(doc);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Length": String(buffer.length),
    },
  });
});
