import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.js";
import { actorFrom } from "../auth/middleware.js";
import { createBugReport } from "../db/bugReports.js";

// POST /bug-reports — the PDA/admin "Report a bug" button (spec
// docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md). Any
// authenticated user; the reporter comes from the JWT, never the body.
// Triage lives under /admin/bug-reports (routes/admin/bugReports.ts).

export const bugReportsRoute = new Hono();

bugReportsRoute.post("/bug-reports", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => {
    throw new HTTPException(400, { message: "invalid JSON body" });
  });
  const result = await createBugReport(
    db,
    {
      app: String(body.app ?? ""),
      route: String(body.route ?? ""),
      category: typeof body.category === "string" && body.category !== "" ? body.category : null,
      note: String(body.note ?? ""),
      context: body.context,
      trail: body.trail,
      photoBase64: typeof body.photo === "string" && body.photo !== "" ? body.photo : null,
      photoMime: typeof body.photoMime === "string" ? body.photoMime : null,
    },
    actorFrom(c)
  );
  return c.json(result, 201);
});
