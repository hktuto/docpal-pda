import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { v4 as uuid } from 'uuid';
import * as schema from '../db/schema';
import { createTablesSql } from '../db/init';
import { findReceivingCandidates, type OcrParseResult } from '../db/ocrPicking';
import { findMatchingUnverifiedPackage, type PackageVerificationInput } from '../db/measuring';

async function createTestDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(createTablesSql);
  const db = drizzle(pg, { schema });
  return db;
}

describe('findReceivingCandidates empty-field wildcard', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let receivingOrderId: string;
  let partId: string;

  beforeEach(async () => {
    db = await createTestDb();
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
    await db.insert(schema.suppliers).values({ id: supplierId, code: 'KOA', name: 'KOA' });

    partId = uuid();
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
      arrivedAt: now,
      arrivedBy: userId,
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

    await db.insert(schema.receivingInvoiceItems).values({
      id: uuid(),
      receivingInvoiceId: invoiceId,
      partId,
      poNo: 'PO-001',
      poLine: '1',
      qty: 1000,
      receivedQty: 1000,
      pickedQty: 0,
      putAwayQty: 0,
      dateCode: '',
      lotCode: '',
      coo: 'CN',
      cow: 'USA',
    });
  });

  it('matches when the receiving item has empty date/lot and the scan provides values', async () => {
    const parsed: OcrParseResult = {
      partNo: 'RK73B1JTTD181G',
      dateCode: '2544',
      lotCode: 'LOT123',
      coo: 'CN',
      cow: 'USA',
      qty: 100,
    };

    const candidates = await findReceivingCandidates(db, receivingOrderId, parsed);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].partNo).toBe('RK73B1JTTD181G');
  });

  it('still requires coo/cow to match when the receiving item provides them', async () => {
    const parsed: OcrParseResult = {
      partNo: 'RK73B1JTTD181G',
      dateCode: '2544',
      lotCode: 'LOT123',
      coo: 'JP',
      cow: 'USA',
      qty: 100,
    };

    const candidates = await findReceivingCandidates(db, receivingOrderId, parsed);

    expect(candidates).toHaveLength(0);
  });
});

describe('findMatchingUnverifiedPackage empty-field wildcard', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let shippingBoxId: string;

  beforeEach(async () => {
    db = await createTestDb();
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
    await db.insert(schema.suppliers).values({ id: supplierId, code: 'KOA', name: 'KOA' });

    const partId = uuid();
    await db.insert(schema.parts).values({
      id: partId,
      partNo: 'RK73B1JTTD181G',
      internalCode: '',
      description: '',
      defaultCoo: 'CN',
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
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const pickingItemId = uuid();
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

    await db.insert(schema.pickingPackages).values({
      id: uuid(),
      pickingItemId,
      pickingOrderId,
      sourceType: 'receiving_invoice_item',
      sourceId: uuid(),
      qty: 100,
      shippingBoxId,
      dateCode: '',
      lotCode: '',
      coo: 'CN',
      cow: 'USA',
      verified: false,
      createdAt: now,
    });
  });

  it('matches when the package has empty date/lot and the scan provides values', async () => {
    const input: PackageVerificationInput = {
      partNo: 'RK73B1JTTD181G',
      dateCode: '2544',
      lotCode: 'LOT123',
      coo: 'CN',
      cow: 'USA',
      qty: 100,
    };

    const matched = await findMatchingUnverifiedPackage(db, shippingBoxId, input);

    expect(matched).not.toBeNull();
  });

  it('still requires coo/cow to match when the package provides them', async () => {
    const input: PackageVerificationInput = {
      partNo: 'RK73B1JTTD181G',
      dateCode: '2544',
      lotCode: 'LOT123',
      coo: 'JP',
      cow: 'USA',
      qty: 100,
    };

    const matched = await findMatchingUnverifiedPackage(db, shippingBoxId, input);

    expect(matched).toBeNull();
  });

  it('matches when the scan has empty date/lot and the package provides values', async () => {
    const input: PackageVerificationInput = {
      partNo: 'RK73B1JTTD181G',
      dateCode: '',
      lotCode: '',
      coo: 'CN',
      cow: 'USA',
      qty: 100,
    };

    const matched = await findMatchingUnverifiedPackage(db, shippingBoxId, input);

    expect(matched).not.toBeNull();
  });
});

// TODO: put-away matcher tests
// useScanMatchers relies on Nuxt runtime composables (useDb, useAuth, useI18n),
// which are not trivially mockable in this in-memory PGlite test harness.
// The put-away scan path is covered directly in tests/putAway.test.ts by
// exercising recordPutAwayScan, which is the DB helper invoked by matchPutAway.
