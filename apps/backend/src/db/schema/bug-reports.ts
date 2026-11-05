import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { now } from "../now.js";

// In-app bug reports (spec docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md):
// the PDA/admin "Report a bug" button's inbox. This is NOT a business entity —
// no transaction_logs/inventory_transactions rows, no SSE. `trail` is the
// client's self-contained activity ring buffer (api/scan/route/error entries),
// `photo` is the ≤5 MB resized JPEG the user attached, stored base64 in-row
// (this drizzle build has no bytea column; base64 costs 33% but rides pg
// backups with no volume mount). `uat_ref` cross-references a
// docs/uat/bugs/BUG-xxx.json ledger row — one-way sync (this table is the
// inbox, the repo tracker stays the ledger).
export const bugReports = pgTable(
  "bug_reports",
  {
    id: text("id").primaryKey(),
    app: text("app").notNull(), // "pda" | "admin"
    route: text("route").notNull(), // fullPath at report time
    category: text("category"), // snake_case vocabulary; NULL = pre-feature rows
    note: text("note").notNull(),
    reporter: text("reporter").notNull(), // username from the JWT, never the body (no FK — DocPal users)
    context: jsonb("context").notNull().default(sql`'{}'::jsonb`), // {userAgent, sessionId, appVersion}
    trail: jsonb("trail").notNull().default(sql`'[]'::jsonb`), // activity ring buffer snapshot
    photo: text("photo"), // base64, server-capped
    photoMime: text("photo_mime"),
    status: text("status").notNull().default("open"), // open | triaged | closed
    uatRef: text("uat_ref"), // "BUG-0xx" once folded into the UAT tracker
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    appCheck: check("chk_bug_reports_app", sql`app IN ('pda', 'admin')`),
    statusCheck: check("chk_bug_reports_status", sql`status IN ('open', 'triaged', 'closed')`),
    statusIdx: index("idx_bug_reports_status_created").on(t.status, t.createdDate),
    reporterIdx: index("idx_bug_reports_reporter").on(t.reporter),
  })
);
