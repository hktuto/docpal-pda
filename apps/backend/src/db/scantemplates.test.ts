import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { listScanTemplates } from "./scantemplates.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

test("scan-templates: every supplier profile, ordered by supplier_code (null templates included)", async () => {
  await reseed(client);

  // seed: the KOA and KOA+TCG profiles (serialNo group in the template)
  let rows = await listScanTemplates(client.db);
  assert.deepEqual(rows, [
    {
      supplierCode: "KOA",
      qrTemplate:
        "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$",
      qtyEncoding: "koa_zeros",
    },
    {
      supplierCode: "KOA+TCG",
      qrTemplate:
        "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$",
      qtyEncoding: "koa_zeros",
    },
  ]);

  // a profile without a template is returned too (clients filter nulls)
  await client.db.execute(
    sql`INSERT INTO suppliers (id, code, name) VALUES (${randomUUID()}, 'ACME', 'ACME')`
  );
  await client.db.execute(
    sql`INSERT INTO supplier_profiles (id, supplier_code, created_at, updated_at)
        VALUES (${randomUUID()}, 'ACME', now(), now())`
  );
  rows = await listScanTemplates(client.db);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { supplierCode: "ACME", qrTemplate: null, qtyEncoding: null });
  assert.equal(rows[1].supplierCode, "KOA");
  assert.equal(rows[2].supplierCode, "KOA+TCG");
});
