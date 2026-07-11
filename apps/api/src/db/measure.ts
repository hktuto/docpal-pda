import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbOrTx } from "./invariants.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

interface BoxRow { id: string; pickingOrderId: string; status: string; boxSize: string | null; netWeightG: number | null; grossWeightG: number | null; destinationCountry: string | null }

function loadBox(tx: DbOrTx, boxId: string): BoxRow {
  const box = tx.get<BoxRow>(
    sql`SELECT id, picking_order_id AS pickingOrderId, status, box_size AS boxSize,
               net_weight_g AS netWeightG, gross_weight_g AS grossWeightG, destination_country AS destinationCountry
        FROM shipping_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shipping box not found" });
  return box;
}

/** undefined = leave unchanged; null = clear; otherwise parsed/trimmed value. */
function parseGrams(v: number | string | null | undefined, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HTTPException(400, { message: `${field} must be a non-negative integer (grams)` });
  return n;
}

function cleanText(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function updateShippingBoxMeasurements(
  tx: DbOrTx,
  a: { shippingBoxId: string; fields: { boxSize?: string | null; netWeightG?: number | string | null; grossWeightG?: number | string | null; destinationCountry?: string | null } }
): void {
  const box = loadBox(tx, a.shippingBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const size = cleanText(a.fields.boxSize);
  const net = parseGrams(a.fields.netWeightG, "net_weight_g");
  const gross = parseGrams(a.fields.grossWeightG, "gross_weight_g");
  const dest = cleanText(a.fields.destinationCountry);
  tx.run(
    sql`UPDATE shipping_boxes SET
          box_size = ${size === undefined ? box.boxSize : size},
          net_weight_g = ${net === undefined ? box.netWeightG : net},
          gross_weight_g = ${gross === undefined ? box.grossWeightG : gross},
          destination_country = ${dest === undefined ? box.destinationCountry : dest},
          updated_at = ${now()}
        WHERE id = ${box.id}`
  );
}
