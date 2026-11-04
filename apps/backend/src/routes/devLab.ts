// ---------------------------------------------------------------------------
// Dev Lab routes (dev-only, under the open /dev/* allowlist, DEV_ROUTES gate):
// a single HTML page + JSON endpoints that let a developer generate real
// supplier-label barcodes for PDA testing without a physical reel — pick a
// brand/part, tweak qty / date / lot / coo / serial, get the raw label, what
// the REAL decoder reads back, and a PNG in the supplier's own symbology
// (bwip-js) so the PDA's barcode_types scanner whitelist accepts it.
// Builders: src/lab/labelBuilders.ts. Not mounted in production.
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryAll } from "../db/query.js";
import { dateCodeFormat } from "../config.js";
import { listScanTemplates } from "../db/scantemplates.js";
import { listDateCodePeriods } from "../db/dateCodePeriods.js";
import { parseQrRaw } from "../decode/codecs.js";
import { buildLabLabelRaw, LAB_BUILDERS, type LabLabelInput } from "../lab/labelBuilders.js";
import { LAB_PAGE } from "../lab/page.js";
import bwip from "bwip-js/node";

export const devLabRoute = new Hono()
  .get("/dev/lab", (c) => c.html(LAB_PAGE))

  .get("/dev/lab/data", async (c) => {
    const [rows, brandRows] = await Promise.all([
      queryAll<{
        supplierCode: string;
        supplierName: string | null;
        brands: string[] | null;
        qrType: string | null;
        barcodeTypes: string[] | null;
      }>(
        db,
        sql`SELECT sp.supplier_code AS "supplierCode", COALESCE(sp.name, s.name) AS "supplierName",
                   sp.brands, sp.qr_type AS "qrType", sp.barcode_types AS "barcodeTypes"
            FROM supplier_profiles sp LEFT JOIN suppliers s ON s.code = sp.supplier_code
            ORDER BY sp.supplier_code`
      ),
      queryAll<{ brand: string }>(db, sql`SELECT DISTINCT brand FROM parts ORDER BY brand`),
    ]);
    return c.json({
      suppliers: rows.map((r) => ({
        ...r,
        fields: LAB_BUILDERS[r.supplierCode]?.fields ?? null,
      })),
      brands: brandRows.map((b) => b.brand),
    });
  })

  // Parts for the lab's part picker; drawnos attached from the externally
  // managed wcl_part_drawno table when it exists (NCC labels key on it).
  .get("/dev/lab/parts", async (c) => {
    const brand = c.req.query("brand")?.trim();
    const parts = await queryAll<{ partNo: string; wclItemNo: string; description: string | null }>(
      db,
      brand
        ? sql`SELECT part_no AS "partNo", wcl_item_no AS "wclItemNo", description FROM parts
              WHERE brand = ${brand} ORDER BY part_no LIMIT 300`
        : sql`SELECT part_no AS "partNo", wcl_item_no AS "wclItemNo", description FROM parts
              ORDER BY part_no LIMIT 300`
    );
    const drawnoByWcl: Record<string, string[]> = {};
    if (parts.length) {
      try {
        const needles = sql.join(
          parts.map((p) => sql`${p.wclItemNo}`),
          sql`, `
        );
        const rows = await queryAll<{ wclItemNo: string; drawno: string }>(
          db,
          sql`SELECT wcl_part_no AS "wclItemNo", drawno FROM wcl_part_drawno WHERE wcl_part_no IN (${needles})`
        );
        for (const r of rows) (drawnoByWcl[r.wclItemNo] ??= []).push(r.drawno);
      } catch (err) {
        if ((err as { code?: string }).code !== "42P01") throw err; // table missing = no drawnos
      }
    }
    return c.json(
      parts.map((p) => ({ ...p, drawnos: drawnoByWcl[p.wclItemNo] ?? [] }))
    );
  })

  // Build the raw label for a supplier and feed it through the REAL decoder
  // so a generated label provably matches what the PDA scan path reads.
  .post("/dev/lab/label", async (c) => {
    let body: LabLabelInput & { supplierCode?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const supplierCode = (body.supplierCode ?? "").trim();
    if (!LAB_BUILDERS[supplierCode])
      return c.json({ error: `no builder for supplier "${supplierCode}" — use raw-text mode` }, 400);
    const [templates, periods] = await Promise.all([listScanTemplates(db), listDateCodePeriods(db)]);
    const row = templates.find((t) => t.supplierCode === supplierCode);
    if (!row?.qrTemplate) return c.json({ error: `supplier "${supplierCode}" has no qr_template` }, 404);
    const fmt = dateCodeFormat();
    let raw: string;
    try {
      raw = buildLabLabelRaw(supplierCode, body, { dateCodePeriods: periods });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const decoded = parseQrRaw(
      raw,
      row.qrTemplate,
      row.qtyEncoding,
      row.dateCodeEncoding,
      periods,
      fmt,
      row.brands
    );
    // A builder output that its own template won't parse is a lab bug — still
    // return it (dev tool: see the broken label rather than get a bare error).
    return c.json({
      raw,
      decoded,
      warning: decoded.partNo ? undefined : "built label does not decode back — this is a dev-lab bug, please report it",
    });
  })

  // Render any text as a barcode PNG (base64 in JSON), in the symbology the
  // caller picks (the page defaults to the supplier's qr_type).
  .post("/dev/lab/barcode", async (c) => {
    let body: { text?: string; bcid?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const text = body.text ?? "";
    if (!text) return c.json({ error: "text is required" }, 400);
    if (text.length > 1000) return c.json({ error: "text too long (max 1000 chars)" }, 400);
    const bcid = body.bcid || "qrcode";
    try {
      const png = await bwip.toBuffer({
        bcid,
        text,
        scale: 4,
        ...(bcid === "interleaved2of5" ? { height: 80, padding: 10 } : {}),
      });
      return c.json({ image: png.toString("base64"), bcid });
    } catch (err) {
      return c.json({ error: `barcode render failed: ${(err as Error).message}` }, 400);
    }
  });
