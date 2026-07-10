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
});
