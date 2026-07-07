import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { v4 as uuid } from 'uuid';
import * as schema from '../db/schema';
import { createTablesSql } from '../db/init';
import {
  reportReceivingItemMismatch,
  confirmReceivingItemMismatch,
  cancelReceivingItemMismatch,
  getActiveMismatchForItem,
} from '../db/mismatch';
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

  const otherActorId = uuid();
  await db.insert(schema.users).values({
    id: otherActorId,
    username: 'other',
    passwordHash: 'pw',
    displayName: 'Other',
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

  return { actorId, otherActorId, supplierId, partId };
}

async function createReceivingItem(db: Awaited<ReturnType<typeof createTestDb>>, partId: string, qty: number) {
  const now = new Date();
  const orderId = uuid();
  await db.insert(schema.receivingOrders).values({
    id: orderId,
    refNo: 'RO-001',
    status: 'in_hand',
    createdAt: now,
    updatedAt: now,
  });

  const invoiceId = uuid();
  await db.insert(schema.receivingInvoices).values({
    id: invoiceId,
    receivingOrderId: orderId,
    invoiceNo: 'INV-001',
  });

  const itemId = uuid();
  await db.insert(schema.receivingInvoiceItems).values({
    id: itemId,
    receivingInvoiceId: invoiceId,
    partId,
    qty,
    receivedQty: qty,
    pickedQty: 0,
    putAwayQty: 0,
  });

  return itemId;
}

describe('receiving item mismatch', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let actorId: string;
  let otherActorId: string;
  let partId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const seeded = await seedUserSupplierPart(db);
    actorId = seeded.actorId;
    otherActorId = seeded.otherActorId;
    partId = seeded.partId;
  });

  it('reports a pending mismatch and updates received_qty', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, 'box crushed');

    const mismatch = await getActiveMismatchForItem(db, itemId);
    expect(mismatch?.status).toBe('pending');
    expect(mismatch?.effectiveReceivedQty).toBe(70);

    const item = await db.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, itemId),
    });
    expect(item?.receivedQty).toBe(70);
  });

  it('confirms a pending mismatch', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await confirmReceivingItemMismatch(db, mismatch!.id, otherActorId);

    const updated = await getActiveMismatchForItem(db, itemId);
    expect(updated?.status).toBe('confirmed');
  });

  it('prevents reporter from confirming their own mismatch', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await expect(confirmReceivingItemMismatch(db, mismatch!.id, actorId)).rejects.toThrow(I18nError);
  });

  it('cancels a pending mismatch and reverts received_qty', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await cancelReceivingItemMismatch(db, mismatch!.id, otherActorId);

    const item = await db.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, itemId),
    });
    expect(item?.receivedQty).toBe(100);
    expect(await getActiveMismatchForItem(db, itemId)).toBeNull();
  });

  it('blocks cancellation when stock is already consumed beyond effective qty', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    await db.update(schema.receivingInvoiceItems).set({ pickedQty: 80 }).where(eq(schema.receivingInvoiceItems.id, itemId));
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await expect(cancelReceivingItemMismatch(db, mismatch!.id, otherActorId)).rejects.toThrow(I18nError);
  });
});
