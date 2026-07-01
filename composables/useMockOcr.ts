import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import type { OcrParseResult } from "~/db/ocrPicking";

export interface MockPreset {
  id: string;
  rawText: string;
  parsed: OcrParseResult;
}

export function useMockOcr() {
  async function generatePresets(
    db: PgliteDatabase<typeof schema>,
    receivingOrderId: string
  ): Promise<MockPreset[]> {
    const rows = await db.execute(sql`
      SELECT DISTINCT
        p.part_no,
        rii.date_code,
        rii.lot_code,
        rii.origin_country,
        (rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0)) AS qty
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      JOIN parts p ON p.id = rii.part_id
      LEFT JOIN (
        SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
        FROM allocations
        WHERE receiving_invoice_item_id IS NOT NULL
        GROUP BY receiving_invoice_item_id
      ) alloc ON alloc.receiving_invoice_item_id = rii.id
      WHERE ro.id = ${receivingOrderId}
        AND ro.status = 'in_hand'
        AND rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) > 0
      ORDER BY p.part_no
      LIMIT 10
    `);

    const presets: MockPreset[] = (rows.rows ?? []).map((row, idx) => {
      const partNo = normalize(String(row.part_no));
      const dateCode = row.date_code ? normalizeCode(String(row.date_code)) : null;
      const lotCode = row.lot_code ? normalizeCode(String(row.lot_code)) : null;
      const originCountry = row.origin_country ? normalize(String(row.origin_country)) : null;
      const qty = Number(row.qty);
      const rawText = [partNo, dateCode, lotCode, qty, originCountry]
        .filter(Boolean)
        .join(" ");

      return {
        id: `preset-${idx}`,
        rawText,
        parsed: { partNo, dateCode, lotCode, originCountry, qty },
      };
    });

    // Always include one guaranteed no-match preset so the demo can show the error path.
    presets.push({
      id: "preset-no-match",
      rawText: "NOMATCH-999 2099Z XX9 1 NA",
      parsed: {
        partNo: "NOMATCH-999",
        dateCode: "2099Z",
        lotCode: "XX9",
        originCountry: "NA",
        qty: 1,
      },
    });

    return presets;
  }

  /**
   * Base normalization: trim, uppercase, collapse whitespace.
   * Keeps dashes and letters intact so part numbers like KOA-103 stay valid.
   */
  function normalize(value: string): string {
    return value.trim().toUpperCase().replace(/\s+/g, " ");
  }

  /**
   * Code normalization: same as base plus common OCR digit substitutions.
   * Use only for fields that are known to be codes/dates/lots, not part numbers.
   */
  function normalizeCode(value: string): string {
    return normalize(value)
      .replace(/O/g, "0")
      .replace(/I/g, "1")
      .replace(/L/g, "1")
      .replace(/Z/g, "2")
      .replace(/S/g, "5");
  }

  function scan(preset: MockPreset): OcrParseResult {
    return {
      partNo: normalize(preset.parsed.partNo),
      dateCode: preset.parsed.dateCode ? normalizeCode(preset.parsed.dateCode) : null,
      lotCode: preset.parsed.lotCode ? normalizeCode(preset.parsed.lotCode) : null,
      originCountry: preset.parsed.originCountry ? normalize(preset.parsed.originCountry) : null,
      qty: preset.parsed.qty,
    };
  }

  return { generatePresets, scan, normalize };
}
