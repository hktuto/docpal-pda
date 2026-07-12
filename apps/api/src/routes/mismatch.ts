import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { mismatchReasons, type MismatchReason } from "@warehouse/shared";
import { db } from "../db.js";
import { cancelMismatch, confirmMismatch, editMismatch, getLatestMismatch, reportMismatch } from "../db/mismatch.js";

export const mismatchRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function requireActorId(body: { actor_id?: unknown }): string {
  const actorId = body.actor_id;
  if (typeof actorId !== "string" || actorId.trim() === "") {
    throw new HTTPException(400, { message: "actor_id is required" });
  }
  return actorId;
}

/** undefined = field absent (PATCH leaves it unchanged); otherwise a valid MismatchReason. */
function parseReason(reason: unknown): MismatchReason | undefined {
  if (reason === undefined) return undefined;
  if (typeof reason !== "string") throw new HTTPException(400, { message: "mismatch_reason_required" });
  if (!(mismatchReasons as readonly string[]).includes(reason)) {
    throw new HTTPException(400, { message: "unhandled_mismatch_reason" });
  }
  return reason as MismatchReason;
}

mismatchRoute.get("/receiving-invoice-items/:id/mismatch", (c) => {
  const itemId = c.req.param("id");
  const item = db.get<{ id: string }>(sql`SELECT id FROM receiving_invoice_items WHERE id = ${itemId}`);
  if (!item) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
  return c.json(getLatestMismatch(db, itemId), 200);
});

mismatchRoute.post("/receiving-invoice-items/:id/mismatches", async (c) => {
  const itemId = c.req.param("id");
  const body = await readJson<{
    reason?: string; mismatch_qty?: number | null; wrong_part_no?: string | null; note?: string | null; actor_id?: string;
  }>(c);
  const actorId = requireActorId(body);
  const reason = parseReason(body.reason);
  if (reason === undefined) throw new HTTPException(400, { message: "mismatch_reason_required" });
  const row = db.transaction((tx) =>
    reportMismatch(tx, {
      receivingInvoiceItemId: itemId,
      reason,
      mismatchQty: body.mismatch_qty ?? null,
      wrongPartNo: body.wrong_part_no ?? null,
      note: body.note ?? null,
      actorId,
    })
  );
  return c.json(row, 201);
});

mismatchRoute.patch("/mismatches/:id", async (c) => {
  const mismatchId = c.req.param("id");
  const body = await readJson<{
    reason?: string; mismatch_qty?: number | null; wrong_part_no?: string | null; note?: string | null; actor_id?: string;
  }>(c);
  const actorId = requireActorId(body);
  const row = db.transaction((tx) =>
    editMismatch(tx, {
      mismatchId,
      actorId,
      reason: parseReason(body.reason),
      mismatchQty: body.mismatch_qty,
      wrongPartNo: body.wrong_part_no,
      note: body.note,
    })
  );
  return c.json(row, 200);
});

mismatchRoute.post("/mismatches/:id/confirm", async (c) => {
  const mismatchId = c.req.param("id");
  const body = await readJson<{ actor_id?: string }>(c);
  const row = db.transaction((tx) => confirmMismatch(tx, { mismatchId, actorId: requireActorId(body) }));
  return c.json(row, 200);
});

mismatchRoute.post("/mismatches/:id/cancel", async (c) => {
  const mismatchId = c.req.param("id");
  const body = await readJson<{ actor_id?: string }>(c);
  const row = db.transaction((tx) => cancelMismatch(tx, { mismatchId, actorId: requireActorId(body) }));
  return c.json(row, 200);
});
