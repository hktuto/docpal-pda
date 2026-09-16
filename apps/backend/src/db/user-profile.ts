// Per-user display preferences on user_profiles (spec
// 2026-09-16-admin-date-format-setting-design.md). Two Unicode-token date
// patterns (date-fns semantics, no dependency): date_format for date-only
// values, date_time_format for timestamps. NULL column = the app default.

import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { newId } from "./id.js";
import { queryGet } from "./query.js";

export const DEFAULT_DATE_FORMAT = "dd/MMM/yyyy";
export const DEFAULT_DATE_TIME_FORMAT = "dd/MMM/yyyy HH:mm";

export interface UserDateFormats {
  dateFormat: string;
  dateTimeFormat: string;
}

/** Pattern syntax guard: letters form tokens, everything else is literal. */
const PATTERN_RE = /^[\w/: .-]{1,64}$/;
const KNOWN_TOKENS = new Set([
  "yyyy", "yy", "MMM", "MM", "M", "dd", "d", "HH", "H", "hh", "mm", "m", "ss", "a",
]);

/** Validate one pattern from an API body; undefined = not provided (leave
 *  unchanged). Throws 400 invalid_date_format on bad input. */
export function parseDateFormat(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "string" || !PATTERN_RE.test(input)) {
    throw new HTTPException(400, { message: "invalid_date_format" });
  }
  const tokens = input.match(/[a-zA-Z]+/g) ?? [];
  if (!tokens.length || tokens.some((t) => !KNOWN_TOKENS.has(t))) {
    throw new HTTPException(400, { message: "invalid_date_format" });
  }
  return input;
}

/** Stored patterns with NULL/absent columns filled with the defaults. */
export async function getUserDateFormats(db: AppDb, username: string): Promise<UserDateFormats> {
  const row = await queryGet<{ df: string | null; dtf: string | null }>(
    db,
    sql`SELECT date_format AS "df", date_time_format AS "dtf" FROM user_profiles WHERE username = ${username}`
  );
  return {
    dateFormat: row?.df ?? DEFAULT_DATE_FORMAT,
    dateTimeFormat: row?.dtf ?? DEFAULT_DATE_TIME_FORMAT,
  };
}

/** Upsert only the format columns by username (pre-provisioning allowed, same
 *  as upsertUserScope) — never touches sub_inventory_scopes. */
export async function upsertUserDateFormats(
  db: AppDb,
  username: string,
  dateFormat: string,
  dateTimeFormat: string
): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_profiles (id, username, date_format, date_time_format, created_date, last_update_date)
    VALUES (${newId()}, ${username}, ${dateFormat}, ${dateTimeFormat}, now(), now())
    ON CONFLICT (username) DO UPDATE
    SET date_format = EXCLUDED.date_format, date_time_format = EXCLUDED.date_time_format,
        last_update_date = now()
  `);
}
