import { pgTable, index, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { now } from "../now.js";

// Scan-event audit log (2026-11-19 scan-truth spec): one row per
// POST /scan/decode call — what was scanned (raw) and what the decoder
// made of it (matched + parsed). Failed (matched=false) attempts are
// logged too; before this table they vanished, leaving no way to audit
// "the system saw X and decoded nothing". Written fire-and-forget after
// the response — never adds latency, never blocks a scan.
export const scanEvents = pgTable(
  "scan_events",
  {
    id: text("id").primaryKey(),
    /** Caller context — decode route labels: 'scan_decode' today; more later. */
    source: text("source").notNull(),
    raw: text("raw").notNull(),
    matched: boolean("matched").notNull(),
    /** supplier_profiles.code of the winning template, NULL on no-match. */
    templateSupplierCode: text("template_supplier_code"),
    /** The parsed fields as returned (itemId/qty/dateCode/lotCode/...). */
    parsed: jsonb("parsed"),
    /** JWT actor when the caller authenticated; NULL for the public endpoint. */
    actorId: text("actor_id"),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => [index("idx_scan_events_created").on(t.createdDate), index("idx_scan_events_raw").on(t.raw)]
);
