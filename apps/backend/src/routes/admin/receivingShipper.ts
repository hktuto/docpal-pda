import { Hono } from "hono";
import { zipSync } from "fflate";
import { db } from "../../db.js";
import { loadShipperDocument, loadShipperDocuments } from "../../export/shipper/data.js";
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
// Split by location is the ONLY mode (spec
// docs/superpowers/specs/2026-09-21-shipper-split-by-location-design.md):
// one xlsx per receiving-office (org_id, sub_inventory_code) section of the
// order's items — a single section returns the plain xlsx under the
// renderer's own file name, multiple sections return a zip of per-section
// files, and an order with no items falls back to the combined document.

export const adminReceivingShipperRoute = new Hono();

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function attachment(buffer: Buffer | Uint8Array, fileName: string, contentType = XLSX_CONTENT_TYPE) {
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Length": String(buffer.length),
    },
  });
}

adminReceivingShipperRoute.get("/receiving-orders/:id/shipper", async (c) => {
  const finished = c.req.query("mode") === "finished";
  const id = c.req.param("id");
  const render = (doc: ShipperDocument) =>
    resolveRenderer<ShipperDocument>("shipper", { supplierCode: doc.head.supplierCode }).render(doc);

  const sections = await loadShipperDocuments(db, id, { finished });
  if (sections.length === 1) {
    const { fileName, buffer } = render(sections[0]!.doc);
    return attachment(buffer, fileName);
  }
  if (sections.length === 0) {
    const { fileName, buffer } = render(await loadShipperDocument(db, id, { finished }));
    return attachment(buffer, fileName);
  }

  const prefix = finished ? "finished-shipper" : "shipper";
  const batchNo = sections[0]!.doc.head.batchNo;
  const sanitize = (s: string) => s.replace(/[/\\:*?"<>|\s]+/g, "-");
  const files = sections.map(({ section, doc }) => {
    const { buffer } = render(doc);
    const subInv = section.subInventoryCode === null ? "no-subinventory" : sanitize(section.subInventoryCode);
    return { fileName: `${prefix}-${batchNo}-org${section.orgId}-${subInv}.xlsx`, buffer };
  });

  // xlsx members are already deflate-compressed zip containers — store-level.
  const zip = zipSync(
    Object.fromEntries(files.map((f) => [f.fileName, new Uint8Array(f.buffer)])),
    { level: 0 }
  );
  return attachment(zip, `${prefix}-${batchNo}.zip`, "application/zip");
});
