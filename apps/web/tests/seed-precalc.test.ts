import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import { createTablesSql } from "~/db/init";
import { seedDb } from "~/db/seed-precalc";

describe("seed-precalc", () => {
  it("seeds with pre-calculated allocations and no runtime allocation errors", async () => {
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(createTablesSql);
    const db = drizzle(pg, { schema });

    await seedDb(db);

    const allocations = await db.query.allocations.findMany();
    const pickingItems = await db.query.pickingItems.findMany();

    expect(allocations.length).toBeGreaterThan(0);
    expect(pickingItems.some((item) => item.allocatedQty > 0)).toBe(true);

    const totalAllocated = pickingItems.reduce((sum, item) => sum + item.allocatedQty, 0);
    const allocationQty = allocations.reduce((sum, a) => sum + a.qty, 0);
    expect(allocationQty).toBe(totalAllocated);
  });
});
