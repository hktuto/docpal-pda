import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../../db.js";
import {
  listBugReports,
  getBugReport,
  patchBugReport,
  deleteBugReports,
  countOpenBugReports,
} from "../../db/bugReports.js";

// Admin triage queue for bug reports (spec
// docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md) — inbox,
// not CRUD: list/detail + status/uat_ref patch + delete. Mounted under
// /admin (admin-group gate applies).

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const adminBugReportsRoute = new Hono();

// Unread badge count (status open|triaged) for the admin nav link.
adminBugReportsRoute.get("/count", async (c) => c.json({ count: await countOpenBugReports(db) }));

// Light list, newest first. ?status=open|triaged|closed, ?category=<vocabulary>.
adminBugReportsRoute.get("/", async (c) => {
  return c.json(
    await listBugReports(db, {
      status: c.req.query("status"),
      category: c.req.query("category"),
    })
  );
});

// Full row: note, context, trail, photo (base64 text as stored).
adminBugReportsRoute.get("/:id", async (c) => c.json(await getBugReport(db, c.req.param("id"))));

// Triage patch: {status?, uatRef?, category?}.
adminBugReportsRoute.patch("/:id", async (c) => {
  const body = await readJson(c);
  return c.json(
    await patchBugReport(db, c.req.param("id"), {
      status: body.status as string | undefined,
      uatRef: body.uatRef as string | null | undefined,
      category: body.category as string | null | undefined,
    })
  );
});

adminBugReportsRoute.delete("/:id", async (c) => c.json(await deleteBugReports(db, c.req.param("id"))));
