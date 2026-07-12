import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { v4 as uuid } from 'uuid';
import * as schema from '~/db/schema';
import { createTablesSql } from '~/db/init';
import { createPgliteWarehouseService } from '~/services/adapters/pgliteWarehouse';

let db: ReturnType<typeof drizzleTestDb>;

function drizzleTestDb(pg: PGlite) {
  return drizzle(pg, { schema });
}

vi.mock('~/composables/useDb', () => ({
  useDb: () => db,
}));

async function createTestDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(createTablesSql);
  db = drizzleTestDb(pg);
  return db;
}

describe('pgliteWarehouse service', () => {
  beforeEach(async () => {
    await createTestDb();
  });

  it('lists receiving orders', async () => {
    const now = new Date();
    const userId = uuid();
    await db.insert(schema.users).values({
      id: userId,
      username: 'operator',
      passwordHash: 'pw',
      displayName: 'Operator',
      role: 'operator',
      createdAt: now,
    });

    const supplierId = uuid();
    await db.insert(schema.suppliers).values({ id: supplierId, code: 'KOA', name: 'KOA Electronics' });

    await db.insert(schema.receivingOrders).values({
      id: uuid(),
      refNo: 'RO-001',
      supplierId,
      deliveryDate: now,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const service = createPgliteWarehouseService({
      adapter: 'pglite',
      getActorId: () => userId,
    });

    const orders = await service.getReceivingOrders('all');
    expect(orders).toHaveLength(1);
    expect(orders[0].refNo).toBe('RO-001');
    expect(orders[0].supplierName).toBe('KOA Electronics');
  });

  it('getScanCandidates groups receiving by collapsed part_no and picking by part_id', async () => {
    const now = new Date();

    const supplierId = uuid();
    await db.insert(schema.suppliers).values({ id: supplierId, code: 'KOA', name: 'KOA' });

    const partId = uuid();
    await db.insert(schema.parts).values({
      id: partId,
      partNo: 'abc  123',
      internalCode: '',
      description: '',
      defaultCoo: 'CN',
    });

    const receivingOrderId = uuid();
    await db.insert(schema.receivingOrders).values({
      id: receivingOrderId,
      refNo: 'RO-002',
      supplierId,
      deliveryDate: now,
      status: 'in_hand',
      createdAt: now,
      updatedAt: now,
    });

    const invoiceId = uuid();
    await db.insert(schema.receivingInvoices).values({
      id: invoiceId,
      receivingOrderId,
      invoiceNo: 'INV-002',
      supplierId,
    });

    await db.insert(schema.receivingInvoiceItems).values({
      id: uuid(),
      receivingInvoiceId: invoiceId,
      partId,
      poNo: 'PO-002',
      poLine: '1',
      qty: 100,
      receivedQty: 100,
      pickedQty: 0,
      putAwayQty: 0,
      dateCode: 'D1',
      lotCode: 'L1',
      coo: 'CN',
      cow: 'USA',
    });

    const pickingOrderId = uuid();
    await db.insert(schema.pickingOrders).values({
      id: pickingOrderId,
      refNo: 'PO-002',
      status: 'picking',
      shipTo: 'Berlin',
      createdAt: now,
      updatedAt: now,
    });

    const pickingItemId = uuid();
    await db.insert(schema.pickingItems).values({
      id: pickingItemId,
      pickingOrderId,
      partId,
      qty: 50,
    });

    await db.insert(schema.allocations).values({
      id: uuid(),
      pickingItemId,
      receivingOrderId,
      qty: 10,
    });

    const service = createPgliteWarehouseService({
      adapter: 'pglite',
      getActorId: () => undefined,
    });

    const result = await service.getScanCandidates(receivingOrderId);

    // Same grouping useScanMatchers relies on: normalize() (trim/uppercase/
    // collapse whitespace) for receiving, part_id for picking.
    expect(Object.keys(result.receivingCandidatesByPartNo)).toEqual(['ABC 123']);
    const receiving = result.receivingCandidatesByPartNo['ABC 123'];
    expect(receiving).toHaveLength(1);
    expect(receiving[0].partId).toBe(partId);
    expect(receiving[0].availableQty).toBe(90); // 100 received - 10 allocated

    expect(Object.keys(result.pickingCandidatesByPartId)).toEqual([partId]);
    const picking = result.pickingCandidatesByPartId[partId];
    expect(picking).toHaveLength(1);
    expect(picking[0].pickingItemId).toBe(pickingItemId);
    expect(picking[0].remainingQty).toBe(50);
  });

  it('getSupplierQrTemplates returns only suppliers with a qr template', async () => {
    await db.insert(schema.suppliers).values({
      id: uuid(),
      code: 'KOA',
      name: 'KOA',
      qrcodeTemplate: '^:(?<itemId>.+)$',
      qrcodeQtyEncoding: 'koa_zeros',
    });
    await db.insert(schema.suppliers).values({ id: uuid(), code: 'MMC', name: 'MMC' });

    const service = createPgliteWarehouseService({
      adapter: 'pglite',
      getActorId: () => undefined,
    });

    const templates = await service.getSupplierQrTemplates();
    expect(templates).toEqual([
      { code: 'KOA', qrcodeTemplate: '^:(?<itemId>.+)$', qrcodeQtyEncoding: 'koa_zeros' },
    ]);
  });
});
