import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { allowedOrgIds, dateCodeFormat, FLOW_STEPS, isStepEnabled } from "../config.js";
import type { AuthTokenUser } from "../auth/jwt.js";
import { bugReports } from "./schema/index.js";
import { newId } from "./id.js";
import { now } from "./now.js";

// Bug report inbox (spec docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md).
// No transaction, no transaction_logs / inventory_transactions / SSE — this is
// a report, not a business mutation. The admin triage page is the delivery
// channel; BUG_REPORT_WEBHOOK (optional) is a best-effort chat ping.

export const BUG_CATEGORIES = [
  "scan_failed",
  "date_code",
  "wrong_data",
  "missing_data",
  "duplicate",
  "label_print",
  "blocked",
  "slow",
  "ui_text",
  "login",
  "other",
] as const;

export const BUG_STATUSES = ["open", "triaged", "closed"] as const;

const MAX_TRAIL_BYTES = 200_000; // client caps at ~40 KB; generous server guard
const MAX_PHOTO_BYTES = 5_000_000;

export interface BugReportInput {
  app: string;
  route: string;
  category: string | null;
  note: string;
  context: unknown;
  trail: unknown;
  photoBase64: string | null;
  photoMime: string | null;
}

/**
 * Validate + insert. `actor` is the JWT user — reporter/groups are never
 * read from the body. `context.server` is stamped here (authoritative):
 * warehouse code, actor groups, and the resolved flow-config snapshot at
 * report time — the cheap way to see HK-vs-SZ config drift while debugging.
 */
export async function createBugReport(
  db: AppDb,
  input: BugReportInput,
  actor: AuthTokenUser
): Promise<{ id: string }> {
  const note = (input.note ?? "").toString().trim();
  if (note === "") throw new HTTPException(400, { message: "note is required" });
  if (input.app !== "pda" && input.app !== "admin") {
    throw new HTTPException(400, { message: "invalid app" });
  }
  if (input.category !== null && !(BUG_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new HTTPException(400, { message: "invalid category" });
  }
  const trailJson = JSON.stringify(input.trail ?? []);
  if (trailJson.length > MAX_TRAIL_BYTES) {
    throw new HTTPException(413, { message: "trail too large" });
  }
  let photo: string | null = null;
  if (input.photoBase64) {
    // decoded size ≈ base64 length × 3/4; reject over the 5 MB cap without
    // materializing the buffer
    if (input.photoBase64.length * 0.75 > MAX_PHOTO_BYTES) {
      throw new HTTPException(413, { message: "photo too large" });
    }
    photo = input.photoBase64;
  }

  const id = newId();
  const warehouseCode = (process.env.WAREHOUSE_CODE ?? "hk").toLowerCase();
  const context = {
    ...(input.context ?? {}),
    server: {
      warehouseCode,
      groupCodes: actor.groupCodes,
      flow: {
        allowedOrgIds: allowedOrgIds(),
        dateCodeFormat: dateCodeFormat(),
        flowSteps: Object.fromEntries(FLOW_STEPS.map((s) => [s, isStepEnabled(s)])),
      },
    },
  };
  await db.insert(bugReports).values({
    id,
    app: input.app,
    route: (input.route ?? "").toString(),
    category: input.category,
    note,
    reporter: actor.username,
    // Same reading as receivingCn.ts: lowercased env selector, HK default.
    warehouseCode,
    context,
    trail: JSON.parse(trailJson) as object,
    photo,
    photoMime: input.photoMime,
    status: "open",
  });

  // Best-effort chat ping (Teams/Slack incoming webhook). A dead webhook must
  // never fail the user's report, so: fire-and-forget, errors swallowed.
  const webhook = process.env.BUG_REPORT_WEBHOOK?.trim();
  if (webhook) {
    void fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reporter: actor.username, app: input.app, route: input.route, category: input.category, warehouse: warehouseCode, note: note.slice(0, 200) }),
    }).catch(() => {});
  }
  return { id };
}

/** Triage list — light columns only (trail/photo can be 200 KB each). */
export async function listBugReports(
  db: AppDb,
  filters: { status?: string; category?: string }
): Promise<Record<string, unknown>[]> {
  const conds = [];
  if (filters.status) conds.push(eq(bugReports.status, filters.status));
  if (filters.category) conds.push(eq(bugReports.category, filters.category));
  const rows = await db
    .select({
      id: bugReports.id,
      createdDate: bugReports.createdDate,
      app: bugReports.app,
      route: bugReports.route,
      category: bugReports.category,
      status: bugReports.status,
      reporter: bugReports.reporter,
      warehouseCode: bugReports.warehouseCode,
      uatRef: bugReports.uatRef,
      hasPhoto: sql<boolean>`photo IS NOT NULL`,
    })
    .from(bugReports)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(bugReports.createdDate))
    .limit(500);
  return rows as unknown as Record<string, unknown>[];
}

export async function getBugReport(db: AppDb, id: string): Promise<Record<string, unknown>> {
  const rows = await db.select().from(bugReports).where(eq(bugReports.id, id)).limit(1);
  if (!rows[0]) throw new HTTPException(404, { message: "not found" });
  return rows[0] as unknown as Record<string, unknown>;
}

export async function patchBugReport(
  db: AppDb,
  id: string,
  patch: { status?: string; uatRef?: string | null; category?: string | null }
): Promise<Record<string, unknown>> {
  const set: Record<string, unknown> = { lastUpdateDate: now() };
  if (patch.status !== undefined) {
    if (!(BUG_STATUSES as readonly string[]).includes(patch.status)) {
      throw new HTTPException(400, { message: "invalid status" });
    }
    set.status = patch.status;
  }
  if (patch.uatRef !== undefined) set.uatRef = patch.uatRef === null ? null : String(patch.uatRef).trim() || null;
  if (patch.category !== undefined) {
    if (patch.category !== null && !(BUG_CATEGORIES as readonly string[]).includes(patch.category)) {
      throw new HTTPException(400, { message: "invalid category" });
    }
    set.category = patch.category;
  }
  const rows = await db
    .update(bugReports)
    .set(set as never)
    .where(eq(bugReports.id, id))
    .returning();
  if (rows.length === 0) throw new HTTPException(404, { message: "not found" });
  return rows[0] as unknown as Record<string, unknown>;
}

export async function deleteBugReports(db: AppDb, id: string): Promise<{ deleted: boolean }> {
  const rows = await db.delete(bugReports).where(eq(bugReports.id, id)).returning({ id: bugReports.id });
  return { deleted: rows.length > 0 };
}

/** Open-count badge for the admin nav link. */
export async function countOpenBugReports(db: AppDb): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bugReports)
    .where(inArray(bugReports.status, ["open", "triaged"]))
    .limit(1);
  return rows[0]?.n ?? 0;
}
