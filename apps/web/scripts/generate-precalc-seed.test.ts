import { describe, it } from "vitest";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import { createTablesSql } from "~/db/init";
import { seedDb } from "~/db/seed";

describe("generate-precalc-seed", () => {
  it("writes db/seed-precalc.ts from current db/seed.ts", async () => {
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(createTablesSql);
    const db = drizzle(pg, { schema });

    await seedDb(db);

    const allocations = await db.query.allocations.findMany();
    const pickingItems = await db.query.pickingItems.findMany();

    const allocatedQtyById = new Map(
      pickingItems.map((item) => [item.id, item.allocatedQty])
    );

    const seedSource = fs.readFileSync("db/seed.ts", "utf8");

    // Build allocation records array (sorted deterministically)
    const allocationRecords = allocations
      .map((a) => ({
        id: a.id,
        pickingItemId: a.pickingItemId,
        inventoryLotId: a.inventoryLotId,
        receivingOrderId: a.receivingOrderId,
        qty: a.qty,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    // Update allocatedQty in pickingItemRecords source based on item id
    const pickingItemsStart = seedSource.indexOf("const pickingItemRecords = [");
    const pickingItemsEnd = seedSource.indexOf(
      "] as const;",
      pickingItemsStart
    );
    if (pickingItemsStart === -1 || pickingItemsEnd === -1) {
      throw new Error("Could not locate pickingItemRecords array");
    }
    const pickingItemsArraySource = seedSource.slice(
      pickingItemsStart,
      pickingItemsEnd + "] as const;".length
    );

    const updatedPickingItemsArraySource = pickingItemsArraySource.replace(
      /\{\s*\n\s*id: '([^']+)',[\s\S]*?allocatedQty: 0,[\s\S]*?\n\s*\}/g,
      (block, id) => {
        const allocatedQty = allocatedQtyById.get(id) ?? 0;
        return block.replace("allocatedQty: 0,", `allocatedQty: ${allocatedQty},`);
      }
    );

    const allocationSection = `// Pre-calculated allocations (${allocationRecords.length})\nconst allocationRecords = ${JSON.stringify(
      allocationRecords,
      null,
      2
    )} as const;\n\n`;

    const precalcSource = seedSource
      .replace(
        'import { allocatePickingOrder } from "./allocate";\n',
        ""
      )
      .replace(pickingItemsArraySource, updatedPickingItemsArraySource)
      .replace(
        /  if \(!options\.skipAllocation\) \{\n    for \(const po of pickingOrderRecords\) \{\n      await allocatePickingOrder\(db, po\.id\);\n    \}\n  \}\n/,
        `  await db.insert(schema.allocations).values([...allocationRecords]);\n`
      )
      .replace(
        "  await db.insert(schema.pickingItems).values([...pickingItemRecords]);\n\n",
        `  await db.insert(schema.pickingItems).values([...pickingItemRecords]);\n\n${allocationSection}`
      );

    fs.writeFileSync("db/seed-precalc.ts", precalcSource);
  });
});
