import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll } from "./query.js";
import type { DateCodePeriod } from "./scanParse.js";

// ---------------------------------------------------------------------------
// Label date-code month-counter periods (date_code_counter_periods). The
// KOA counter rolls 10→99 and restarts; each 90-month cycle is one row here
// and the decoder picks the latest candidate not in the future (see
// scanParse.ts decodeKoaDateCode). A rotation = inserting the next cycle's
// row via the admin CRUD — no code change.
// ---------------------------------------------------------------------------

export async function listDateCodePeriods(db: AppDb): Promise<DateCodePeriod[]> {
  return queryAll<DateCodePeriod>(
    db,
    sql`SELECT encoding, direction, counter_from AS "counterFrom", counter_to AS "counterTo",
               to_char(period_start, 'YYYY-MM-DD') AS "periodStart"
        FROM date_code_counter_periods
        ORDER BY period_start`
  );
}
