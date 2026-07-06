import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { v4 as uuid } from 'uuid';
import * as schema from '../db/schema';
import { createTablesSql } from '../db/init';
import { addAllUnboxedPackagesToBox } from '../db/picking';

async function createTestDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(createTablesSql);
  const db = drizzle(pg, { schema });
  return db;
}

describe('addAllUnboxedPackagesToBox', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let actorId: string;
  let pickingOrderId: string;
  let pickingItemId: string;
  let shippingBoxId: string;
  let packageIds: string[];

  beforeEach(async () => {
    db = await createTestDb();
    const now = new Date();

    actorId = uuid();
    await db.insert(schema.users).values({
      id: actorId,
      username: 'operator',
      passwordHash: 'pw',
      displayName: 'Operator',
      role: 'operator',
      createdAt: now,
    });

    const supplierId = uuid();
    await db.insert(schema.suppliers).values({ id: supplierId, code: 'KOA', name: 'KOA' });

    const partId = uuid();
    await db.insert(schema.parts).values({
      id: partId,
      partNo: 'RK73B1JTTD181G',
      internalCode: '',
      description: '',
      defaultCoo: 'CN',
    });

    pickingOrderId = uuid();
    await db.insert(schema.pickingOrders).values({
      id: pickingOrderId,
      refNo: 'PICK-001',
      supplierId,
      deliveryDate: now,
      poNo: 'PO-PICK',
      requiredDateCodeNotice: null,
      shipTo: 'US',
      destinationCountry: 'USA',
      status: 'picking',
      createdAt: now,
      updatedAt: now,
    });

    pickingItemId = uuid();
    await db.insert(schema.pickingItems).values({
      id: pickingItemId,
      pickingOrderId,
      partId,
      qty: 1000,
      pickedQty: 0,
      allocatedQty: 0,
    });

    shippingBoxId = uuid();
    await db.insert(schema.shippingBoxes).values({
      id: shippingBoxId,
      pickingOrderId,
      status: 'open',
      createdAt: now,
    });

    packageIds = [uuid(), uuid()];
    for (const packageId of packageIds) {
      await db.insert(schema.pickingPackages).values({
        id: packageId,
        pickingItemId,
        pickingOrderId,
        sourceType: 'receiving_invoice_item',
        sourceId: uuid(),
        qty: 100,
        shippingBoxId: null,
        dateCode: '',
        lotCode: '',
        coo: 'CN',
        cow: 'USA',
        verified: false,
        createdAt: now,
      });
    }
  });

  it('adds all unboxed packages to the shipping box', async () => {
    const added = await addAllUnboxedPackagesToBox(db, shippingBoxId, actorId);

    expect(added).toBe(2);

    const packages = await db.query.pickingPackages.findMany({
      where: eq(schema.pickingPackages.pickingOrderId, pickingOrderId),
    });

    expect(packages).toHaveLength(2);
    for (const pkg of packages) {
      expect(pkg.shippingBoxId).toBe(shippingBoxId);
    }
  });

  it('returns 0 when no unboxed packages remain', async () => {
    await addAllUnboxedPackagesToBox(db, shippingBoxId, actorId);

    const added = await addAllUnboxedPackagesToBox(db, shippingBoxId, actorId);

    expect(added).toBe(0);
  });

  it('throws and rolls back when the box is not open', async () => {
    await db.update(schema.shippingBoxes)
      .set({ status: 'closed' })
      .where(eq(schema.shippingBoxes.id, shippingBoxId));

    await expect(addAllUnboxedPackagesToBox(db, shippingBoxId, actorId))
      .rejects.toThrow();

    const boxed = await db.query.pickingPackages.findMany({
      where: eq(schema.pickingPackages.shippingBoxId, shippingBoxId),
    });
    expect(boxed).toHaveLength(0);
  });

  it('updates picking item picked quantities', async () => {
    await addAllUnboxedPackagesToBox(db, shippingBoxId, actorId);

    const item = await db.query.pickingItems.findFirst({
      where: eq(schema.pickingItems.id, pickingItemId),
    });
    expect(item?.pickedQty).toBe(200);
  });
});
