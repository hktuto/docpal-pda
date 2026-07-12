import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { MismatchReason } from "@warehouse/shared";
import { db } from "../db.js";
import { cancelMismatch, confirmMismatch, editMismatch, getLatestMismatch, reportMismatch } from "../db/mismatch.js";

export const mismatchRoute = new Hono();

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function requireActorId(body: Record<string, unknown>): string {
  const actorId = body.actor_id;
  if (typeof actorId !== "string" || actorId.trim() === "") {
    throw new HTTPException(400, { message: "actor_id is required" });
  }
  return actorId;
}

mismatchRoute.get("/receiving-invoice-items/:id/mismatch", (c) => {
  const itemId = c.req.param("id");
  const item = db.get<{ id: string }>(sql`SELECT id FROM receiving_invoice_items WHERE id = ${itemId}`);
  if (!item) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
  return c.json(getLatestMismatch(db, itemId), 200);
});

mismatchRoute.post("/receiving-invoice-items/:id/mismatches", async (c) => {
  const itemId = c.req.param("id");
  const body = await readBody(c);
  const actorId = requireActorId(body);
  if (typeof body.reason !== "string" || body.reason === "") {
    throw new HTTPException(400, { message: "mismatch_reason_required" });
  }
  const row = db.transaction((tx) =>
    reportMismatch(tx, {
      receivingInvoiceItemId: itemId,
      reason: body.reason as MismatchReason,
      mismatchQty: (body.mismatch_qty as number | null | undefined) ?? null,
      wrongPartNo: (body.wrong_part_no as string | null | undefined) ?? null,
      note: (body.note as string | null | undefined) ?? null,
      actorId,
    })
  );
  return c.json(row, 201);
});

mismatchRoute.patch("/mismatches/:id", async (c) => {
  const mismatchId = c.req.param("id");
  const body = await readBody(c);
  const actorId = requireActorId(body);
  const row = db.transaction((tx) =>
    editMismatch(tx, {
      mismatchId,
      actorId,
      reason: body.reason as MismatchReason | undefined,
      mismatchQty: body.mismatch_qty as number | null | undefined,
      wrongPartNo: body.wrong_part_no as string | null | undefined,
      note: body.note as string | null | undefined,
    })
  );
  return c.json(row, 200);
});

mismatchRoute.post("/mismatches/:id/confirm", async (c) => {
  const mismatchId = c.req.param("id");
  const body = await readBody(c);
  const row = db.transaction((tx) => confirmMismatch(tx, { mismatchId, actorId: requireActorId(body) }));
  return c.json(row, 200);
});

mismatchRoute.post("/mismatches/:id/cancel", async (c) => {
  const mismatchId = c.req.param("id");
  const body = await readBody(c);
  const row = db.transaction((tx) => cancelMismatch(tx, { mismatchId, actorId: requireActorId(body) }));
  return c.json(row, 200);
});
