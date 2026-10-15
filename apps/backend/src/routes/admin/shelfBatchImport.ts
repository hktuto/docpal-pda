import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { inArray } from "drizzle-orm";
import { db } from "../../db.js";
import { shelves } from "../../db/schema/index.js";
import { newId } from "../../db/id.js";
import { parseScopeEntries } from "../../db/user-scope.js";

/**
 * POST /admin/shelves/batch-import — create/update many shelves in one call.
 * Each row's code decides create vs update. Invalid rows are skipped and
 * reported; valid rows still succeed.
 */
export const shelfBatchImportRoute = new Hono();

interface ShelfBatchRow {
  code: string;
  displayName?: string | null;
  zone?: string | null;
  warning?: string | null;
  subInventoryScopes?: { orgId: number; code: string }[] | null;
}

shelfBatchImportRoute.post("/", async (c) => {
  const body = await c.req.json<{ shelves?: unknown[] }>();
  if (!Array.isArray(body.shelves) || body.shelves.length === 0) {
    throw new HTTPException(400, { message: "shelves array is required" });
  }

  // Fetch existing codes to decide create vs update
  const existing = await db.select({ code: shelves.code }).from(shelves);
  const existingCodes = new Set(existing.map((r) => r.code));

  const valid: ShelfBatchRow[] = [];
  const errors: { code: string; message: string }[] = [];

  for (const raw of body.shelves) {
    const row = raw as Record<string, unknown>;
    const code = String(row.code ?? "").trim();
    if (!code) {
      errors.push({ code: "(empty)", message: "code is required" });
      continue;
    }

    const displayName = row.displayName != null ? String(row.displayName).trim() || null : null;
    const zone = row.zone != null ? String(row.zone).trim() || null : null;
    const warning = row.warning != null ? String(row.warning).trim() || null : null;

    let subInventoryScopes: { orgId: number; code: string }[] | null = null;
    if (row.subInventoryScopes !== undefined) {
      const entries = parseScopeEntries(row.subInventoryScopes);
      subInventoryScopes = entries.length > 0 ? entries : null;
    }

    valid.push({ code, displayName, zone, warning, subInventoryScopes });
  }

  let created = 0;
  let updated = 0;

  // Batch insert new shelves
  const toCreate = valid.filter((v) => !existingCodes.has(v.code));
  if (toCreate.length > 0) {
    await db.insert(shelves).values(
      toCreate.map((v) => ({
        id: newId(),
        code: v.code,
        displayName: v.displayName,
        zone: v.zone,
        subInventoryScopes: v.subInventoryScopes,
        warning: v.warning,
      }))
    );
    created = toCreate.length;
  }

  // Batch update existing shelves — one UPDATE per row (Drizzle multi-update
  // with CASE is overkill for ≤ a few hundred rows)
  for (const v of valid.filter((v) => existingCodes.has(v.code))) {
    await db
      .update(shelves)
      .set({
        ...(v.displayName !== null && { displayName: v.displayName }),
        ...(v.zone !== null && { zone: v.zone }),
        ...(v.warning !== null && { warning: v.warning }),
        ...(v.subInventoryScopes !== undefined && { subInventoryScopes: v.subInventoryScopes }),
        lastUpdateDate: new Date(),
      })
      .where(eq(shelves.code, v.code));
    updated++;
  }

  return c.json({ created, updated, skipped: errors.length, errors });
});

// Local import to avoid circular dep — eq is from drizzle-orm
import { eq } from "drizzle-orm";
