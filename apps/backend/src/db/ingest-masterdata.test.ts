import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import {
  upsertPart,
  deletePart,
  upsertSupplier,
  deleteSupplier,
  upsertSupplierProfile,
  deleteSupplierProfile,
  upsertSubInventory,
  deleteSubInventory,
  upsertReceivingOrder,
  type IngestReceivingBody,
} from "./ingest.js";

// Master-data ingest: upsert/delete for parts, suppliers, supplier_profiles,
// sub_inventories (same pattern as the order ingests in ingest.test.ts).

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

async function catchHttp(p: Promise<unknown>): Promise<HTTPException> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${err}`);
    return err;
  }
  assert.fail("expected HTTPException");
}

const ID_PART = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_SUPPLIER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_PROFILE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ID_SUBINV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ID_OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/** Minimal receiving order that references a part / supplier / sub-inventory (via the item pair). */
function receivingBody(over: {
  partNo?: string;
  supplierCode?: string;
  orgId?: number;
  subInventoryCode?: string;
}): IngestReceivingBody {
  return {
    order: {
      supplierCode: over.supplierCode ?? null,
    },
    invoices: [
      {
        invoiceNo: "INV-MD-1",
        items: [
          {
            partNo: over.partNo ?? "RK73H1JTTD1002F",
            lineQty: 5,
            orgId: over.orgId ?? 2,
            subInventoryCode: over.subInventoryCode ?? "STORE1",
          },
        ],
      },
    ],
  };
}

// --- parts -------------------------------------------------------------------

test("parts: create (caller id honored) → update reconcile → delete", async () => {
  await reseed(client);

  const res = await upsertPart(client.db, {
    id: ID_PART,
    partNo: "ING-MD-PART-1",
    brand: "INGBRAND",
    wclItemNo: "WCL/ING-MD-PART-1",
    description: "ingest test part",
  });
  assert.equal(res.created, true);
  assert.equal(res.changed, true);
  assert.equal(res.id, ID_PART);

  const row = (await queryGet<{ brand: string; wclItemNo: string }>(
    client.db,
    sql`SELECT brand, wcl_item_no AS "wclItemNo" FROM parts WHERE wcl_item_no = 'WCL/ING-MD-PART-1'`
  ))!;
  assert.equal(row.brand, "INGBRAND");
  assert.equal(row.wclItemNo, "WCL/ING-MD-PART-1");

  // identical re-upsert → nothing changed; a different supplied id is ignored
  const same = await upsertPart(client.db, {
    id: ID_OTHER,
    partNo: "ING-MD-PART-1",
    brand: "INGBRAND",
    wclItemNo: "WCL/ING-MD-PART-1",
    description: "ingest test part",
  });
  assert.equal(same.created, false);
  assert.equal(same.changed, false);
  assert.equal(same.id, ID_PART);

  // changed field → changed: true
  const upd = await upsertPart(client.db, {
    partNo: "ING-MD-PART-1",
    brand: "INGBRAND",
    wclItemNo: "WCL/ING-MD-PART-1",
    description: "ingest test part v2",
  });
  assert.equal(upd.created, false);
  assert.equal(upd.changed, true);

  // delete unknown → 404; happy-path delete
  const err = await catchHttp(deletePart(client.db, "WCL/ING-MD-NOPE"));
  assert.equal(err.status, 404);
  assert.equal(err.message, "not_found");
  const del = await deletePart(client.db, "WCL/ING-MD-PART-1");
  assert.equal(del.id, ID_PART);
  assert.equal(
    await queryGet(client.db, sql`SELECT id FROM parts WHERE part_no = 'ING-MD-PART-1'`),
    undefined
  );
});

test("parts: delete referenced by a receiving line → deletes cleanly (no FK on parts.part_no)", async () => {
  await reseed(client);
  await upsertPart(client.db, { partNo: "ING-MD-PART-2", wclItemNo: "WCL/ING-MD-PART-2", brand: "INGBRAND" });
  await upsertReceivingOrder(client.db, "RO-MD-1", receivingBody({ partNo: "ING-MD-PART-2" }));

  const del = await deletePart(client.db, "WCL/ING-MD-PART-2");
  assert.ok(del.id);
  assert.equal(
    await queryGet(client.db, sql`SELECT id FROM parts WHERE wcl_item_no = 'WCL/ING-MD-PART-2'`),
    undefined
  );
});

test("parts: validation — brand required, invalid_id, id_already_exists", async () => {
  await reseed(client);
  const noBrand = await catchHttp(
    upsertPart(client.db, { partNo: "ING-MD-PART-3", wclItemNo: "WCL/ING-MD-PART-3", brand: "" })
  );
  assert.equal(noBrand.status, 400);

  const badId = await catchHttp(
    upsertPart(client.db, { id: "not-a-uuid", partNo: "ING-MD-PART-3", wclItemNo: "WCL/ING-MD-PART-3", brand: "INGBRAND" })
  );
  assert.equal(badId.status, 400);
  assert.equal(badId.message, "invalid_id");

  await upsertPart(client.db, { id: ID_PART, partNo: "ING-MD-PART-3", wclItemNo: "WCL/ING-MD-PART-3", brand: "INGBRAND" });
  const clash = await catchHttp(
    upsertPart(client.db, { id: ID_PART, partNo: "ING-MD-PART-4", wclItemNo: "WCL/ING-MD-PART-4", brand: "INGBRAND" })
  );
  assert.equal(clash.status, 409);
  assert.equal(clash.message, "id_already_exists");
});

test("parts: duplicate part_no under different wcl_item_no; re-upsert renames part_no", async () => {
  await reseed(client);
  const r1 = await upsertPart(client.db, { partNo: "ING-MD-DUP", wclItemNo: "WCL/ING-MD-DUP-1", brand: "INGBRAND" });
  const r2 = await upsertPart(client.db, { partNo: "ING-MD-DUP", wclItemNo: "WCL/ING-MD-DUP-2", brand: "INGBRAND" });
  assert.equal(r1.created, true);
  assert.equal(r2.created, true);

  const upd = await upsertPart(client.db, { partNo: "ING-MD-RENAMED", wclItemNo: "WCL/ING-MD-DUP-1", brand: "INGBRAND" });
  assert.equal(upd.created, false);
  assert.equal(upd.changed, true);
  assert.equal(upd.id, r1.id);
  const row = (await queryGet<{ partNo: string }>(
    client.db,
    sql`SELECT part_no AS "partNo" FROM parts WHERE wcl_item_no = 'WCL/ING-MD-DUP-1'`
  ))!;
  assert.equal(row.partNo, "ING-MD-RENAMED");
});

// --- suppliers ---------------------------------------------------------------

test("suppliers: create (caller id honored) → update reconcile → delete", async () => {
  await reseed(client);

  const res = await upsertSupplier(client.db, "INGSUP1", { id: ID_SUPPLIER, name: "Ingest Supplier One" });
  assert.equal(res.created, true);
  assert.equal(res.changed, true);
  assert.equal(res.id, ID_SUPPLIER);

  const same = await upsertSupplier(client.db, "INGSUP1", { id: ID_OTHER, name: "Ingest Supplier One" });
  assert.equal(same.created, false);
  assert.equal(same.changed, false);
  assert.equal(same.id, ID_SUPPLIER);

  const upd = await upsertSupplier(client.db, "INGSUP1", { name: "Ingest Supplier One", shortName: "IS1" });
  assert.equal(upd.created, false);
  assert.equal(upd.changed, true);

  const err = await catchHttp(deleteSupplier(client.db, "INGSUP-NOPE"));
  assert.equal(err.status, 404);
  const del = await deleteSupplier(client.db, "INGSUP1");
  assert.equal(del.id, ID_SUPPLIER);
});

test("suppliers: delete referenced by a receiving order / a profile → 409 cannot_delete_referenced", async () => {
  await reseed(client);
  await upsertSupplier(client.db, "INGSUP2", { name: "Referenced Supplier" });
  await upsertReceivingOrder(client.db, "RO-MD-2", receivingBody({ supplierCode: "INGSUP2" }));

  const err = await catchHttp(deleteSupplier(client.db, "INGSUP2"));
  assert.equal(err.status, 409);
  assert.equal(err.message, "cannot_delete_referenced");

  // supplier with a profile is equally undeletable
  await upsertSupplier(client.db, "INGSUP3", { name: "Profiled Supplier" });
  await upsertSupplierProfile(client.db, "INGSUP3", { qrType: "isbn" });
  const err2 = await catchHttp(deleteSupplier(client.db, "INGSUP3"));
  assert.equal(err2.status, 409);
  assert.equal(err2.message, "cannot_delete_referenced");

  // after the profile goes, the supplier deletes cleanly
  await deleteSupplierProfile(client.db, "INGSUP3");
  const del = await deleteSupplier(client.db, "INGSUP3");
  assert.ok(del.id);
});

// --- supplier_profiles ---------------------------------------------------------

test("supplier-profiles: create (caller id honored) → update reconcile → delete", async () => {
  await reseed(client);
  await upsertSupplier(client.db, "INGSUP4", { name: "Profile Supplier" });

  const res = await upsertSupplierProfile(client.db, "INGSUP4", {
    id: ID_PROFILE,
    qrType: "isbn",
    qtyEncoding: "koa_zeros",
    qrTemplateConfig: { version: 1, mode: "delimited" },
  });
  assert.equal(res.created, true);
  assert.equal(res.changed, true);
  assert.equal(res.id, ID_PROFILE);

  // identical re-upsert (jsonb key order differs on the wire) → no change
  const same = await upsertSupplierProfile(client.db, "INGSUP4", {
    id: ID_OTHER,
    qrType: "isbn",
    qtyEncoding: "koa_zeros",
    qrTemplateConfig: { mode: "delimited", version: 1 },
  });
  assert.equal(same.created, false);
  assert.equal(same.changed, false);
  assert.equal(same.id, ID_PROFILE);

  const upd = await upsertSupplierProfile(client.db, "INGSUP4", { qrType: "ban 14" });
  assert.equal(upd.created, false);
  assert.equal(upd.changed, true);
  const row = (await queryGet<{ qrType: string | null; qtyEncoding: string | null }>(
    client.db,
    sql`SELECT qr_type AS "qrType", qty_encoding AS "qtyEncoding" FROM supplier_profiles WHERE supplier_code = 'INGSUP4'`
  ))!;
  assert.equal(row.qrType, "ban 14");
  assert.equal(row.qtyEncoding, null); // absent fields reconcile to null

  const err = await catchHttp(deleteSupplierProfile(client.db, "INGSUP-NOPE"));
  assert.equal(err.status, 404);
  const del = await deleteSupplierProfile(client.db, "INGSUP4");
  assert.equal(del.id, ID_PROFILE);
});

test("supplier-profiles: unknown supplier → 400 unknown_supplier", async () => {
  await reseed(client);
  const err = await catchHttp(upsertSupplierProfile(client.db, "INGSUP-NOPE", { qrType: "isbn" }));
  assert.equal(err.status, 400);
  assert.match(err.message, /^unknown_supplier/);
});

// --- sub_inventories -----------------------------------------------------------

test("sub-inventories: create (caller id honored) → update reconcile → delete", async () => {
  await reseed(client);

  const res = await upsertSubInventory(client.db, "999", "ING-MD-S1", {
    id: ID_SUBINV,
    subinvDescription: "ingest store",
    officeCode: "HK",
    organizationId: 12345,
  });
  assert.equal(res.created, true);
  assert.equal(res.changed, true);
  assert.equal(res.id, ID_SUBINV);

  const row = (await queryGet<{ orgId: number; officeCode: string | null; organizationId: number | null }>(
    client.db,
    sql`SELECT org_id AS "orgId", office_code AS "officeCode", organization_id AS "organizationId"
        FROM sub_inventories WHERE org_id = 999 AND secondary_inventory_name = 'ING-MD-S1'`
  ))!;
  assert.equal(row.officeCode, "HK");
  assert.equal(row.organizationId, 12345);

  const same = await upsertSubInventory(client.db, "999", "ING-MD-S1", {
    id: ID_OTHER,
    subinvDescription: "ingest store",
    officeCode: "HK",
    organizationId: 12345,
  });
  assert.equal(same.created, false);
  assert.equal(same.changed, false);
  assert.equal(same.id, ID_SUBINV);

  const upd = await upsertSubInventory(client.db, "999", "ING-MD-S1", { subinvDescription: "renamed store" });
  assert.equal(upd.created, false);
  assert.equal(upd.changed, true);

  const err = await catchHttp(deleteSubInventory(client.db, "999", "ING-MD-NOPE"));
  assert.equal(err.status, 404);
  const del = await deleteSubInventory(client.db, "999", "ING-MD-S1");
  assert.equal(del.id, ID_SUBINV);
});

test("sub-inventories: delete referenced by a receiving order → 409 cannot_delete_referenced", async () => {
  await reseed(client);
  await upsertSubInventory(client.db, "999", "ING-MD-S2", {});
  await upsertReceivingOrder(
    client.db,
    "RO-MD-3",
    receivingBody({ orgId: 999, subInventoryCode: "ING-MD-S2" })
  );

  const err = await catchHttp(deleteSubInventory(client.db, "999", "ING-MD-S2"));
  assert.equal(err.status, 409);
  assert.equal(err.message, "cannot_delete_referenced");
});

test("sub-inventories: invalid orgId / unknown customer / bad organizationId → 400", async () => {
  await reseed(client);
  const badOrg = await catchHttp(upsertSubInventory(client.db, "abc", "ING-MD-S3", {}));
  assert.equal(badOrg.status, 400);
  assert.equal(badOrg.message, "invalid_org_id");
  const badOrgDel = await catchHttp(deleteSubInventory(client.db, "1.5", "ING-MD-S3"));
  assert.equal(badOrgDel.status, 400);
  assert.equal(badOrgDel.message, "invalid_org_id");

  const badCust = await catchHttp(upsertSubInventory(client.db, "999", "ING-MD-S3", { customerCode: "NOPE" }));
  assert.equal(badCust.status, 400);
  assert.match(badCust.message, /^unknown_customer/);

  const badOrgIdField = await catchHttp(
    upsertSubInventory(client.db, "999", "ING-MD-S3", { organizationId: 1.5 })
  );
  assert.equal(badOrgIdField.status, 400);

  // customerCode resolves against customer_profiles
  const ok = await upsertSubInventory(client.db, "999", "ING-MD-S3", { customerCode: "ACME" });
  assert.equal(ok.created, true);
});
