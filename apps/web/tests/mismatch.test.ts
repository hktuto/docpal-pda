import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { v4 as uuid } from 'uuid';
import * as schema from '../db/schema';
import { createTablesSql } from '../db/init';
import {
  reportReceivingItemMismatch,
  editReceivingItemMismatch,
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

async function getReceivingOrderStatusForItem(
  db: Awaited<ReturnType<typeof createTestDb>>,
  receivingInvoiceItemId: string
): Promise<string | null> {
  const item = await db.query.receivingInvoiceItems.findFirst({
    where: eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId),
    columns: { receivingInvoiceId: true },
  });
  if (!item) return null;

  const invoice = await db.query.receivingInvoices.findFirst({
    where: eq(schema.receivingInvoices.id, item.receivingInvoiceId),
    columns: { receivingOrderId: true },
  });
  if (!invoice?.receivingOrderId) return null;

  const order = await db.query.receivingOrders.findFirst({
    where: eq(schema.receivingOrders.id, invoice.receivingOrderId),
    columns: { status: true },
  });
  return order?.status ?? null;
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

  it('blocks cancellation when stock already consumed beyond previous received qty', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    await db.update(schema.receivingInvoiceItems).set({ pickedQty: 110 }).where(eq(schema.receivingInvoiceItems.id, itemId));
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await expect(cancelReceivingItemMismatch(db, mismatch!.id, otherActorId)).rejects.toThrow(I18nError);
  });

  it('edits a pending mismatch and updates received_qty', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await editReceivingItemMismatch(db, mismatch!.id, actorId, 'damaged', 10, null, 'less damage');

    const updated = await getActiveMismatchForItem(db, itemId);
    expect(updated?.effectiveReceivedQty).toBe(90);

    const item = await db.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, itemId),
    });
    expect(item?.receivedQty).toBe(90);
  });

  it('blocks edit by a non-reporter', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await expect(editReceivingItemMismatch(db, mismatch!.id, otherActorId, 'damaged', 10, null, '')).rejects.toThrow(I18nError);
  });

  it('blocks edit when mismatch is not pending', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await confirmReceivingItemMismatch(db, mismatch!.id, otherActorId);
    await expect(editReceivingItemMismatch(db, mismatch!.id, actorId, 'damaged', 10, null, '')).rejects.toThrow(I18nError);
  });

  it('blocks confirm when mismatch is not pending', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await cancelReceivingItemMismatch(db, mismatch!.id, otherActorId);
    await expect(confirmReceivingItemMismatch(db, mismatch!.id, otherActorId)).rejects.toThrow(I18nError);
  });

  it('blocks cancel when mismatch is not pending', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await confirmReceivingItemMismatch(db, mismatch!.id, otherActorId);
    await expect(cancelReceivingItemMismatch(db, mismatch!.id, otherActorId)).rejects.toThrow(I18nError);
  });

  it('blocks reporting when stock already consumed beyond effective qty', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await db.update(schema.receivingInvoiceItems).set({ pickedQty: 80 }).where(eq(schema.receivingInvoiceItems.id, itemId));
    await expect(reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '')).rejects.toThrow(I18nError);
  });

  it('blocks reporting when a confirmed mismatch already exists', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await confirmReceivingItemMismatch(db, mismatch!.id, otherActorId);
    await expect(reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 10, null, '')).rejects.toThrow(I18nError);
  });

  it('allows cancel reversion when consumed is between effective and previous qty', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    await db.update(schema.receivingInvoiceItems).set({ pickedQty: 80 }).where(eq(schema.receivingInvoiceItems.id, itemId));
    const mismatch = await getActiveMismatchForItem(db, itemId);
    await cancelReceivingItemMismatch(db, mismatch!.id, otherActorId);

    const item = await db.query.receivingInvoiceItems.findFirst({
      where: eq(schema.receivingInvoiceItems.id, itemId),
    });
    expect(item?.receivedQty).toBe(100);
    expect(await getActiveMismatchForItem(db, itemId)).toBeNull();
  });

  it('transitions parent receiving order to clear when mismatch zeroes available stock', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    expect(await getReceivingOrderStatusForItem(db, itemId)).toBe('in_hand');

    await reportReceivingItemMismatch(db, itemId, actorId, 'not_found', null, null, 'missing');

    expect(await getReceivingOrderStatusForItem(db, itemId)).toBe('clear');
  });

  it('transitions parent receiving order back to in_hand when mismatch is cancelled', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'not_found', null, null, 'missing');
    expect(await getReceivingOrderStatusForItem(db, itemId)).toBe('clear');

    const mismatch = await getActiveMismatchForItem(db, itemId);
    await cancelReceivingItemMismatch(db, mismatch!.id, otherActorId);

    expect(await getReceivingOrderStatusForItem(db, itemId)).toBe('in_hand');
  });

  it('transitions parent receiving order to clear when pending mismatch is edited to zero available stock', async () => {
    const itemId = await createReceivingItem(db, partId, 100);
    await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
    expect(await getReceivingOrderStatusForItem(db, itemId)).toBe('in_hand');

    const mismatch = await getActiveMismatchForItem(db, itemId);
    await editReceivingItemMismatch(db, mismatch!.id, actorId, 'not_found', null, null, '');

    expect(await getReceivingOrderStatusForItem(db, itemId)).toBe('clear');
  });
});
