import { Hono } from "hono";
import { db } from "../../db.js";
import { getPartLedger } from "../../db/partLedger.js";

// Item ledger (admin item-ledger page): a part's current stock + totals and
// its in/out movement history, matched exactly by partNo OR wclItemNo.
// Read-only; 400 part_no_required when both params are blank.
export const adminPartLedgerRoute = new Hono();

adminPartLedgerRoute.get("/part-ledger", async (c) => {
  const partNo = c.req.query("partNo")?.trim() ?? "";
  const wclItemNo = c.req.query("wclItemNo")?.trim() ?? "";
  return c.json(await getPartLedger(db, partNo, wclItemNo));
});
