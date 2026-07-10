import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import * as schema from '../db/schema';
import { createTablesSql } from '../db/init';
import {
  recordPutAwayScan,
  assignScanToBox,
  removeScanFromBox,
  removeScannedPiece,
  cancelShelfBox,
  getPutAwayCandidates,
  addAllUnboxedScansToBox,
  createShelfBox,
} from '../db/putAway';

async function createTestDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(createTablesSql);
  const db = drizzle(pg, { schema });
  return db;
}

describe('put-away scan flow', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let receivingOrderId: string;
  let receivingInvoiceItemId: string;
  let shelfBoxId: string;
  let actorId: string;
  let partId: string;

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

    partId = uuid();
    await db.insert(schema.parts).values({
      id: partId,
      partNo: 'RK73B1JTTD181G',
      internalCode: '',
      description: '',
      defaultCoo: 'CN',
    });

    const shelfCode = 'A-01';
    await db.insert(schema.shelves).values({ code: shelfCode, zone: 'A' });

    receivingOrderId = uuid();
    await db.insert(schema.receivingOrders).values({
      id: receivingOrderId,
      refNo: 'RO-001',
      supplierId,
      deliveryDate: now,
      status: 'in_hand',
      arrivedAt: now,
      arrivedBy: actorId,
      createdAt: now,
      updatedAt: now,
    });

    const invoiceId = uuid();
    await db.insert(schema.receivingInvoices).values({
      id: invoiceId,
      receivingOrderId,
      invoiceNo: 'INV-001',
      supplierId,
    });

    receivingInvoiceItemId = uuid();
    await db.insert(schema.receivingInvoiceItems).values({
      id: receivingInvoiceItemId,
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

    shelfBoxId = uuid();
    await db.insert(schema.shelfBoxes).values({
      id: shelfBoxId,
      receivingOrderId,
      shelfCode,
      status: 'open',
      createdAt: now,
    });
  });

  it('records a scan within remaining qty', async () => {
    const scan = await recordPutAwayScan(
      db,
      receivingInvoiceItemId,
      5000,
      '2544',
      'LOT1',
      'CN',
      'USA'
    );
    expect(scan.qty).toBe(5000);
    expect(scan.shelfBoxId).toBeNull();
  });

  it('rejects scan that exceeds remaining qty', async () => {
    await recordPutAwayScan(db, receivingInvoiceItemId, 6000, '2544', 'LOT1', 'CN', 'USA');
    await expect(
      recordPutAwayScan(db, receivingInvoiceItemId, 5000, '2544', 'LOT1', 'CN', 'USA')
    ).rejects.toThrow('scanned_qty_exceeds_total');
  });

  it('assigns scan to box and updates inventory', async () => {
    const scan = await recordPutAwayScan(
      db,
      receivingInvoiceItemId,
      5000,
      '2544',
      'LOT1',
      'CN',
      'USA'
    );
    await assignScanToBox(db, scan.id, shelfBoxId, actorId);

    const [updatedItem] = await db
      .select()
      .from(schema.receivingInvoiceItems)
      .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));
    expect(updatedItem.putAwayQty).toBe(5000);

    const scans = await db.query.putAwayScans.findMany({
      where: eq(schema.putAwayScans.shelfBoxId, shelfBoxId),
    });
    expect(scans).toHaveLength(1);
    expect(scans[0].qty).toBe(5000);
    expect(scans[0].verified).toBe(false);
    expect(scans[0].verifiedAt).toBeNull();

    const lots = await db.query.inventoryLots.findMany();
    expect(lots).toHaveLength(1);
    expect(lots[0].totalQty).toBe(5000);
    expect(lots[0].shelfCode).toBe('A-01');
  });

  it('removes scan from box and reverses inventory', async () => {
    const scan = await recordPutAwayScan(
      db,
      receivingInvoiceItemId,
      5000,
      '2544',
      'LOT1',
      'CN',
      'USA'
    );
    await assignScanToBox(db, scan.id, shelfBoxId, actorId);

    await db
      .update(schema.putAwayScans)
      .set({ verified: true, verifiedAt: new Date() })
      .where(eq(schema.putAwayScans.id, scan.id));

    await removeScanFromBox(db, scan.id, actorId);

    const [updatedItem] = await db
      .select()
      .from(schema.receivingInvoiceItems)
      .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));
    expect(updatedItem.putAwayQty).toBe(0);

    const [updatedScan] = await db
      .select()
      .from(schema.putAwayScans)
      .where(eq(schema.putAwayScans.id, scan.id));
    expect(updatedScan.shelfBoxId).toBeNull();
    expect(updatedScan.verified).toBe(false);
    expect(updatedScan.verifiedAt).toBeNull();

    const lots = await db.query.inventoryLots.findMany();
    expect(lots).toHaveLength(0);
  });

  it('removes unboxed scan', async () => {
    const scan = await recordPutAwayScan(
      db,
      receivingInvoiceItemId,
      5000,
      '2544',
      'LOT1',
      'CN',
      'USA'
    );
    await removeScannedPiece(db, scan.id);

    const scans = await db.query.putAwayScans.findMany();
    expect(scans).toHaveLength(0);
  });

  it('cannot cancel box with assigned scans', async () => {
    const scan = await recordPutAwayScan(
      db,
      receivingInvoiceItemId,
      5000,
      '2544',
      'LOT1',
      'CN',
      'USA'
    );
    await assignScanToBox(db, scan.id, shelfBoxId, actorId);

    await expect(cancelShelfBox(db, shelfBoxId, actorId)).rejects.toThrow(
      'shelf_box_is_not_empty'
    );
  });

  it('list still shows order when all quantity is scanned but unboxed', async () => {
    await recordPutAwayScan(
      db,
      receivingInvoiceItemId,
      10000,
      '2544',
      'LOT1',
      'CN',
      'USA'
    );

    const candidates = await getPutAwayCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(receivingOrderId);
    expect(candidates[0].available_qty).toBe(0);
  });
});

async function seedMinimalReceivingOrder(db: Awaited<ReturnType<typeof createTestDb>>) {
  const now = new Date();
  const actorId = uuid();
  await db.insert(schema.users).values({
    id: actorId,
    username: 'op',
    passwordHash: 'pw',
    displayName: 'Op',
    role: 'operator',
    createdAt: now,
  });

  const supplierId = uuid();
  await db.insert(schema.suppliers).values({ id: supplierId, code: 'KOA', name: 'KOA' });

  await db.insert(schema.shelves).values({ code: 'A-01', zone: 'A' });

  const partId = uuid();
  await db.insert(schema.parts).values({
    id: partId,
    partNo: 'RK73B1JTTD181G',
    internalCode: '',
    description: '',
    defaultCoo: 'CN',
  });

  const receivingOrderId = uuid();
  await db.insert(schema.receivingOrders).values({
    id: receivingOrderId,
    refNo: 'RO-001',
    supplierId,
    deliveryDate: now,
    status: 'in_hand',
    createdAt: now,
    updatedAt: now,
  });

  const receivingInvoiceId = uuid();
  await db.insert(schema.receivingInvoices).values({
    id: receivingInvoiceId,
    receivingOrderId,
    invoiceNo: 'INV-001',
    createdAt: now,
  });

  const receivingInvoiceItemId = uuid();
  await db.insert(schema.receivingInvoiceItems).values({
    id: receivingInvoiceItemId,
    receivingInvoiceId,
    partId,
    qty: 100,
    receivedQty: 100,
    pickedQty: 0,
    putAwayQty: 0,
    dateCode: '2544',
    lotCode: 'L1',
    coo: 'CN',
    cow: 'USA',
  });

  return { actorId, receivingOrderId, receivingInvoiceItemId, partId };
}

describe('addAllUnboxedScansToBox', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('adds all unboxed scans to the box', async () => {
    const { actorId, receivingOrderId, receivingInvoiceItemId, partId } = await seedMinimalReceivingOrder(db);
    const box = await createShelfBox(db, receivingOrderId, 'A-01', actorId);

    const scan1 = await recordPutAwayScan(db, receivingInvoiceItemId, 10, '2544', 'L1', 'CN', 'USA');
    const scan2 = await recordPutAwayScan(db, receivingInvoiceItemId, 20, '2544', 'L1', 'CN', 'USA');

    const count = await addAllUnboxedScansToBox(db, box.id, actorId);
    expect(count).toBe(2);

    const updated1 = await db.query.putAwayScans.findFirst({ where: (pas, { eq }) => eq(pas.id, scan1.id) });
    const updated2 = await db.query.putAwayScans.findFirst({ where: (pas, { eq }) => eq(pas.id, scan2.id) });
    expect(updated1?.shelfBoxId).toBe(box.id);
    expect(updated2?.shelfBoxId).toBe(box.id);

    const item = await db.query.receivingInvoiceItems.findFirst({
      where: (rii, { eq }) => eq(rii.id, receivingInvoiceItemId),
    });
    expect(item?.putAwayQty).toBe(30);

    const lots = await db.query.inventoryLots.findMany({
      where: (il, { eq }) => eq(il.boxId, box.id),
    });
    expect(lots).toHaveLength(1);
    expect(lots[0].totalQty).toBe(30);
  });

  it('returns 0 when no unboxed scans exist', async () => {
    const { actorId, receivingOrderId, receivingInvoiceItemId } = await seedMinimalReceivingOrder(db);
    const box = await createShelfBox(db, receivingOrderId, 'A-01', actorId);

    await recordPutAwayScan(db, receivingInvoiceItemId, 10, '2544', 'L1', 'CN', 'USA');
    await addAllUnboxedScansToBox(db, box.id, actorId);

    const count = await addAllUnboxedScansToBox(db, box.id, actorId);
    expect(count).toBe(0);
  });

  it('throws when the box is not open', async () => {
    const { actorId, receivingOrderId, receivingInvoiceItemId } = await seedMinimalReceivingOrder(db);
    const box = await createShelfBox(db, receivingOrderId, 'A-01', actorId);
    await assignScanToBox(db, (await recordPutAwayScan(db, receivingInvoiceItemId, 10, '2544', 'L1', 'CN', 'USA')).id, box.id, actorId);
    await db.update(schema.shelfBoxes).set({ status: 'closed' }).where(eq(schema.shelfBoxes.id, box.id));

    await expect(addAllUnboxedScansToBox(db, box.id, actorId)).rejects.toThrow('shelf_box_is_not_open');
  });
});
