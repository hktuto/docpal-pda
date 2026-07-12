import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db.js";

export const suppliersRoute = new Hono();

// Ported from apps/web/db/suppliers.ts getSuppliersWithQrTemplates. The web
// query has no ORDER BY; the API orders by code for a stable response. Field
// names follow the API's snake_case convention (web returns qrcodeTemplate /
// qrcodeQtyEncoding camelCase internally).
suppliersRoute.get("/suppliers/qr-templates", (c) => {
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT code, qr_template, qrcode_qty_encoding
    FROM suppliers
    WHERE qr_template IS NOT NULL
    ORDER BY code
  `);
  return c.json(
    rows.map((row) => ({
      code: String(row.code),
      qr_template: String(row.qr_template),
      qrcode_qty_encoding:
        row.qrcode_qty_encoding == null ? null : String(row.qrcode_qty_encoding),
    })),
    200,
  );
});
