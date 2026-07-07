import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import * as schema from '../db/schema';
import { createTablesSql } from '../db/init';
import {
  getShelfBoxesByShelf,
  getShelfBoxDetail,
  verifyShelfBoxScans,
  markShelfBoxVerified,
} from '../db/goodsVerify';
import { I18nError } from '../composables/i18nError';

async function createTestDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(createTablesSql);
  return drizzle(pg, { schema });
}

async function seedUserSupplierPart(db: Awaited<ReturnType<typeof createTestDb>>) {
  const now = new Date();
  const actorId = uuid();
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
    description: 'Test Resistor',
    defaultCoo: 'CN',
  });

  const shelfCode = 'A-01';
  await db.insert(schema.shelves).values({ code: shelfCode, zone: 'A' });

  return { actorId, supplierId, partId, shelfCode };
}

async function createReceivingItem(
  db: Awaited<ReturnType<typeof createTestDb>>,
  supplierId: string,
  partId: string
) {
  const now = new Date();
  const orderId = uuid();
  await db.insert(schema.receivingOrders).values({
    id: orderId,
    refNo: 'RO-001',
    supplierId,
    status: 'in_hand',
    createdAt: now,
    updatedAt: now,
  });

  const invoiceId = uuid();
  await db.insert(schema.receivingInvoices).values({
    id: invoiceId,
    receivingOrderId: orderId,
    invoiceNo: 'INV-001',
    supplierId,
  });

  const itemId = uuid();
  await db.insert(schema.receivingInvoiceItems).values({
    id: itemId,
    receivingInvoiceId: invoiceId,
    partId,
    poNo: 'PO-001',
    poLine: '1',
    qty: 10000,
    receivedQty: 10000,
    pickedQty: 0,
    putAwayQty: 0,
    dateCode: '2544',
    lotCode: 'LOT1',
    coo: 'CN',
    cow: 'USA',
  });

  return { orderId, invoiceId, itemId };
}

async function createShelfBox(
  db: Awaited<ReturnType<typeof createTestDb>>,
  orderId: string,
  shelfCode: string
) {
  const boxId = uuid();
  await db.insert(schema.shelfBoxes).values({
    id: boxId,
    receivingOrderId: orderId,
    shelfCode,
    status: 'open',
    createdAt: new Date(),
  });
  return boxId;
}

async function insertScan(
  db: Awaited<ReturnType<typeof createTestDb>>,
  receivingInvoiceItemId: string,
  partId: string,
  shelfBoxId: string,
  qty: number,
  overrides: Partial<typeof schema.putAwayScans.$inferInsert> = {}
) {
  const now = new Date();
  await db.insert(schema.putAwayScans).values({
    id: uuid(),
    receivingInvoiceItemId,
    partId,
    qty,
    dateCode: '2544',
    lotCode: 'LOT1',
    coo: 'CN',
    cow: 'USA',
    shelfBoxId,
    verified: false,
    createdAt: now,
    ...overrides,
  });
}

describe('goods verify', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let actorId: string;
  let supplierId: string;
  let partId: string;
  let shelfCode: string;
  let itemId: string;
  let orderId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const seeded = await seedUserSupplierPart(db);
    actorId = seeded.actorId;
    supplierId = seeded.supplierId;
    partId = seeded.partId;
    shelfCode = seeded.shelfCode;

    const receiving = await createReceivingItem(db, supplierId, partId);
    itemId = receiving.itemId;
    orderId = receiving.orderId;
  });

  it('returns empty array for unknown shelf', async () => {
    const boxes = await getShelfBoxesByShelf(db, 'UNKNOWN');
    expect(boxes).toEqual([]);
  });

  it('aggregates item counts and verified counts correctly, including partially verified boxes', async () => {
    const secondPartId = uuid();
    await db.insert(schema.parts).values({
      id: secondPartId,
      partNo: 'RK73B1JTTD182G',
      internalCode: '',
      description: 'Second Part',
      defaultCoo: 'CN',
    });
    const secondReceiving = await createReceivingItem(db, supplierId, secondPartId);

    const boxId = await createShelfBox(db, orderId, shelfCode);

    await insertScan(db, itemId, partId, boxId, 5000);
    await insertScan(db, itemId, partId, boxId, 3000);
    await insertScan(db, secondReceiving.itemId, secondPartId, boxId, 2000, { verified: true, verifiedAt: new Date() });

    const boxes = await getShelfBoxesByShelf(db, shelfCode);
    expect(boxes).toHaveLength(1);

    const box = boxes[0];
    expect(box.itemCount).toBe(2);
    expect(box.verifiedCount).toBe(1);
    expect(box.lastCheckAt).not.toBeNull();
  });

  it('returns null for unknown box', async () => {
    const detail = await getShelfBoxDetail(db, uuid());
    expect(detail).toBeNull();
  });

  it('aggregates scans into composite items', async () => {
    const boxId = await createShelfBox(db, orderId, shelfCode);

    await insertScan(db, itemId, partId, boxId, 4000);
    await insertScan(db, itemId, partId, boxId, 2000);

    const detail = await getShelfBoxDetail(db, boxId);
    expect(detail).not.toBeNull();
    expect(detail!.items).toHaveLength(1);

    const item = detail!.items[0];
    expect(item.qty).toBe(6000);
    expect(item.part?.partNo).toBe('RK73B1JTTD181G');
    expect(item.part?.description).toBe('Test Resistor');
    expect(item.verified).toBe(false);
  });

  it('marks scans verified and updates verifiedAt', async () => {
    const boxId = await createShelfBox(db, orderId, shelfCode);
    await insertScan(db, itemId, partId, boxId, 1000);

    await verifyShelfBoxScans(db, boxId, partId);

    const scans = await db.query.putAwayScans.findMany({
      where: eq(schema.putAwayScans.shelfBoxId, boxId),
    });
    expect(scans).toHaveLength(1);
    expect(scans[0].verified).toBe(true);
    expect(scans[0].verifiedAt).not.toBeNull();
  });

  it('throws shelf_box_item_not_found when no scans match', async () => {
    const boxId = await createShelfBox(db, orderId, shelfCode);
    await insertScan(db, itemId, partId, boxId, 1000);

    const missingPartId = uuid();
    await expect(verifyShelfBoxScans(db, boxId, missingPartId)).rejects.toThrow(
      new I18nError('shelf_box_item_not_found')
    );
  });

  it('throws when not all scans are verified, then succeeds when they are', async () => {
    const boxId = await createShelfBox(db, orderId, shelfCode);
    await insertScan(db, itemId, partId, boxId, 1000);

    await expect(markShelfBoxVerified(db, boxId, actorId)).rejects.toThrow(
      new I18nError('not_all_shelf_box_items_verified')
    );

    await verifyShelfBoxScans(db, boxId, partId);
    await markShelfBoxVerified(db, boxId, actorId);

    const box = await db.query.shelfBoxes.findFirst({
      where: eq(schema.shelfBoxes.id, boxId),
    });
    expect(box?.status).toBe('verified');
  });
});
