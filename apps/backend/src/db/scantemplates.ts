import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll } from "./query.js";

// ---------------------------------------------------------------------------
// Scan support: supplier QR templates for client-side label parsing. The
// receiving scan parses server-side (scanParse.ts), but picking / put-away /
// measuring scans validate labels on the client against these templates.
// ---------------------------------------------------------------------------

export interface ScanTemplateRow {
  supplierCode: string;
  qrTemplate: string | null;
  qtyEncoding: string | null;
}

/**
 * Every supplier profile's QR template + qty encoding, ordered by supplier
 * code. Profiles without a template (null qr_template) are included — clients
 * filter them out when parsing.
 */
export async function listScanTemplates(db: AppDb): Promise<ScanTemplateRow[]> {
  return queryAll<ScanTemplateRow>(
    db,
    sql`SELECT supplier_code AS "supplierCode", qr_template AS "qrTemplate", qty_encoding AS "qtyEncoding"
        FROM supplier_profiles ORDER BY supplier_code`
  );
}
