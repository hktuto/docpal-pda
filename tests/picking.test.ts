import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { v4 as uuid } from 'uuid';
import * as schema from '../db/schema';
import { createTablesSql } from '../db/init';
import { addAllUnboxedPackagesToBox, addPackageToBox } from '../db/picking';
import { applyOcrPick } from '../db/ocrPicking';
import { I18nError } from '../composables/i18nError';

async function createTestDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(createTablesSql);
  const db = drizzle(pg, { schema });
  return db;
}

async function expectI18nError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toThrow();
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (e) {
    expect(e).toBeInstanceOf(I18nError);
    expect((e as I18nError).code).toBe(code);
  }
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

    await expectI18nError(
      addAllUnboxedPackagesToBox(db, shippingBoxId, actorId),
      'box_is_not_open',
    );

    const boxed = await db.query.pickingPackages.findMany({
      where: eq(schema.pickingPackages.shippingBoxId, shippingBoxId),
    });
    expect(boxed).toHaveLength(0);
  });

  it('throws when the picking order is already finished', async () => {
    await db.update(schema.pickingOrders)
      .set({ status: 'finished' })
      .where(eq(schema.pickingOrders.id, pickingOrderId));

    await expectI18nError(
      addAllUnboxedPackagesToBox(db, shippingBoxId, actorId),
      'picking_order_already_finished',
    );

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

  it('auto-finishes the picking order once after batching the final packages', async () => {
    await db.update(schema.pickingItems)
      .set({ qty: 200 })
      .where(eq(schema.pickingItems.id, pickingItemId));

    const added = await addAllUnboxedPackagesToBox(db, shippingBoxId, actorId);
    expect(added).toBe(2);

    const order = await db.query.pickingOrders.findFirst({
      where: eq(schema.pickingOrders.id, pickingOrderId),
    });
    expect(order?.status).toBe('finished');

    const task = await db.query.measuringTasks.findFirst({
      where: eq(schema.measuringTasks.pickingOrderId, pickingOrderId),
    });
    expect(task).toBeTruthy();
  });
});

describe('addPackageToBox', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let actorId: string;
  let pickingOrderId: string;
  let pickingItemId: string;
  let shippingBoxId: string;
  let packageId: string;

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

    packageId = uuid();
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
  });

  it('adds a single unboxed package to an open box', async () => {
    await addPackageToBox(db, packageId, shippingBoxId, actorId);

    const pkg = await db.query.pickingPackages.findFirst({
      where: eq(schema.pickingPackages.id, packageId),
    });
    expect(pkg?.shippingBoxId).toBe(shippingBoxId);

    const item = await db.query.pickingItems.findFirst({
      where: eq(schema.pickingItems.id, pickingItemId),
    });
    expect(item?.pickedQty).toBe(100);
  });

  it('throws when the package is already in a box', async () => {
    await addPackageToBox(db, packageId, shippingBoxId, actorId);

    await expectI18nError(
      addPackageToBox(db, packageId, shippingBoxId, actorId),
      'package_already_in_box',
    );
  });

  it('throws when the box is not open', async () => {
    await db.update(schema.shippingBoxes)
      .set({ status: 'closed' })
      .where(eq(schema.shippingBoxes.id, shippingBoxId));

    await expectI18nError(
      addPackageToBox(db, packageId, shippingBoxId, actorId),
      'box_is_not_open',
    );
  });

  it('throws when the shipping box is not associated with a picking order', async () => {
    const orphanBoxId = uuid();
    const now = new Date();
    await db.insert(schema.shippingBoxes).values({
      id: orphanBoxId,
      pickingOrderId: null,
      status: 'open',
      createdAt: now,
    });

    await expectI18nError(
      addPackageToBox(db, packageId, orphanBoxId, actorId),
      'shipping_box_not_associated',
    );

    const pkg = await db.query.pickingPackages.findFirst({
      where: eq(schema.pickingPackages.id, packageId),
    });
    expect(pkg?.shippingBoxId).toBeNull();
  });

  it('throws when the package does not belong to the box picking order', async () => {
    const otherOrderId = uuid();
    const otherBoxId = uuid();
    const now = new Date();
    await db.insert(schema.pickingOrders).values({
      id: otherOrderId,
      refNo: 'PICK-OTHER',
      supplierId: (await db.query.suppliers.findFirst())!.id as string,
      deliveryDate: now,
      poNo: 'PO-OTHER',
      requiredDateCodeNotice: null,
      shipTo: 'US',
      destinationCountry: 'USA',
      status: 'picking',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.shippingBoxes).values({
      id: otherBoxId,
      pickingOrderId: otherOrderId,
      status: 'open',
      createdAt: now,
    });

    await expectI18nError(
      addPackageToBox(db, packageId, otherBoxId, actorId),
      'package_does_not_belong_to_picking_order',
    );
  });

  it('throws when the picking order has an open issue', async () => {
    await db.update(schema.pickingOrders)
      .set({ status: 'issue' })
      .where(eq(schema.pickingOrders.id, pickingOrderId));

    await expectI18nError(
      addPackageToBox(db, packageId, shippingBoxId, actorId),
      'picking_order_has_open_issue',
    );
  });

  it('throws when the picking order is already finished', async () => {
    await db.update(schema.pickingOrders)
      .set({ status: 'finished' })
      .where(eq(schema.pickingOrders.id, pickingOrderId));

    await expectI18nError(
      addPackageToBox(db, packageId, shippingBoxId, actorId),
      'picking_order_already_finished',
    );
  });

  it('auto-finishes the picking order when the last required quantity is boxed', async () => {
    await db.update(schema.pickingItems)
      .set({ qty: 100 })
      .where(eq(schema.pickingItems.id, pickingItemId));

    await addPackageToBox(db, packageId, shippingBoxId, actorId);

    const order = await db.query.pickingOrders.findFirst({
      where: eq(schema.pickingOrders.id, pickingOrderId),
    });
    expect(order?.status).toBe('finished');

    const task = await db.query.measuringTasks.findFirst({
      where: eq(schema.measuringTasks.pickingOrderId, pickingOrderId),
    });
    expect(task).toBeTruthy();
  });
});

describe('applyOcrPick splits scan across invoice items', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let actorId: string;
  let receivingOrderId: string;
  let firstInvoiceItemId: string;
  let secondInvoiceItemId: string;
  let pickingItemId: string;

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

    receivingOrderId = uuid();
    await db.insert(schema.receivingOrders).values({
      id: receivingOrderId,
      refNo: 'RO-001',
      supplierId,
      deliveryDate: now,
      status: 'in_hand',
      createdAt: now,
      updatedAt: now,
    });

    const firstInvoiceId = uuid();
    await db.insert(schema.receivingInvoices).values({
      id: firstInvoiceId,
      receivingOrderId,
      invoiceNo: 'INV-001',
      supplierId,
    });

    firstInvoiceItemId = uuid();
    await db.insert(schema.receivingInvoiceItems).values({
      id: firstInvoiceItemId,
      receivingInvoiceId: firstInvoiceId,
      partId,
      qty: 10000,
      receivedQty: 10000,
      pickedQty: 0,
      putAwayQty: 0,
    });

    const secondInvoiceId = uuid();
    await db.insert(schema.receivingInvoices).values({
      id: secondInvoiceId,
      receivingOrderId,
      invoiceNo: 'INV-002',
      supplierId,
    });

    secondInvoiceItemId = uuid();
    await db.insert(schema.receivingInvoiceItems).values({
      id: secondInvoiceItemId,
      receivingInvoiceId: secondInvoiceId,
      partId,
      qty: 190000,
      receivedQty: 190000,
      pickedQty: 0,
      putAwayQty: 0,
    });

    const pickingOrderId = uuid();
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
      qty: 200000,
      pickedQty: 0,
      allocatedQty: 0,
    });

    await db.transaction(async (tx) => {
      await tx.insert(schema.allocations).values({
        id: uuid(),
        pickingItemId,
        receivingOrderId,
        qty: 200000,
      });
      await tx.update(schema.pickingItems)
        .set({ allocatedQty: 200000 })
        .where(eq(schema.pickingItems.id, pickingItemId));
    });
  });

  it('distributes a 20,000 piece scan across two invoice items', async () => {
    await expect(
      applyOcrPick(db, receivingOrderId, pickingItemId, 20000, null, null, null, null, actorId)
    ).resolves.toBeUndefined();

    const packages = await db.query.pickingPackages.findMany({
      where: eq(schema.pickingPackages.pickingItemId, pickingItemId),
    });

    expect(packages).toHaveLength(2);
    expect(packages.map((pkg) => pkg.qty).sort((a, b) => a - b)).toEqual([10000, 10000]);

    const firstItem = await db.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, firstInvoiceItemId),
    });
    const secondItem = await db.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, secondInvoiceItemId),
    });

    expect(firstItem?.pickedQty).toBe(10000);
    expect(secondItem?.pickedQty).toBe(10000);

    const allocations = await db.query.allocations.findMany({
      where: eq(schema.allocations.pickingItemId, pickingItemId),
    });
    const remainingAllocationQty = allocations.reduce((sum, allocation) => sum + allocation.qty, 0);
    expect(remainingAllocationQty).toBe(180000);
  });
});
