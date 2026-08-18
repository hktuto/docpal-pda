import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "./test-helper.js";
import { listScanTemplates } from "./scantemplates.js";

// optJson lives in routes/admin/crud.js, which pulls in the module-level db
// (src/db.ts — connects + migrates at import). DATABASE_URL must point at the
// test database before that import happens — hence the dynamic import below
// (same pattern as auth.test.ts).
process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let optJson: (typeof import("../routes/admin/crud.js"))["optJson"];

before(async () => {
  client = await setupTestDb();
  ({ optJson } = await import("../routes/admin/crud.js"));
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
    sql`INSERT INTO supplier_profiles (id, supplier_code, creation_date, last_update_date)
        VALUES (${randomUUID()}, 'ACME', now(), now())`
  );
  rows = await listScanTemplates(client.db);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { supplierCode: "ACME", qrTemplate: null, qtyEncoding: null });
  assert.equal(rows[1].supplierCode, "KOA");
  assert.equal(rows[2].supplierCode, "KOA+TCG");
});

test("supplier_profiles: qr_template_config jsonb round-trips (seed + update)", async () => {
  await reseed(client);

  // seed: both KOA profiles carry the editor config
  const seeded = await client.db.execute(
    sql`SELECT qr_template_config AS config FROM supplier_profiles WHERE supplier_code = 'KOA'`
  );
  assert.deepEqual(seeded[0]!.config, {
    version: 1,
    mode: "delimited",
    delimiter: ":",
    fields: [
      { role: "ignore" },
      { role: "itemId" },
      { role: "ignore" },
      { role: "qty" },
      { role: "ignore" },
      { role: "lotCode" },
      { role: "serialNo" },
      { role: "ignore" },
    ],
  });

  // update round-trips a fixed-mode config verbatim
  const fixed = { version: 1, mode: "fixed", fields: [{ role: "itemId", start: 0, length: 14 }] };
  await client.db.execute(
    sql`UPDATE supplier_profiles SET qr_template_config = ${JSON.stringify(fixed)}::jsonb
        WHERE supplier_code = 'KOA+TCG'`
  );
  const updated = await client.db.execute(
    sql`SELECT qr_template_config AS config FROM supplier_profiles WHERE supplier_code = 'KOA+TCG'`
  );
  assert.deepEqual(updated[0]!.config, fixed);
});

test("optJson: object passes, null clears, non-object rejected", () => {
  assert.deepEqual(optJson({ qrTemplateConfig: { a: 1 } }, "qrTemplateConfig"), { a: 1 });
  assert.equal(optJson({ qrTemplateConfig: null }, "qrTemplateConfig"), null);
  assert.equal(optJson({}, "qrTemplateConfig"), null);
  assert.throws(() => optJson({ qrTemplateConfig: "nope" }, "qrTemplateConfig"), /must be an object/);
});
