import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../db/test-helper.js";
import { upsertReceivingOrder } from "./receiving.js";
import { assertInvariantsHold } from "../db/invariants.guard.js";
import type { ReceivingPutBody } from "@warehouse/shared";

const { sql, db } = await createTestDb();

test.beforeEach(async () => {
  await db.execute(
    `TRUNCATE TABLE receiving_orders, receiving_invoices, receiving_invoice_items, parts, suppliers CASCADE`
  );
});

function seedInHand(orderId: string) {
  return db.execute(
    `UPDATE receiving_orders SET status='in_hand' WHERE id='${orderId}'`
  );
}

test("upsertReceivingOrder creates order + invoices + items with norms; received_qty stays 0 while pending", async () => {
  await db.execute(
    `INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('s','SUP','S','0','0')`
  );
  const body: ReceivingPutBody = {
    order: { ref_no: "RO-1", delivery_date: "2026-07-20", supplier_code: "SUP" },
    invoices: [
      {
        invoice_no: "INV-1",
        items: [
          { line_no: 1, part_no: "ABO", qty: 100, date_code: "2024O1", coo: "cn" },
          { line_no: 2, part_no: "X1", qty: 5, box_id: "B1" },
        ],
      },
      {
        invoice_no: "INV-2",
        supplier_code: "SUP",
        items: [{ line_no: 1, part_no: "ABO", qty: 50 }],
      },
    ],
  };
  const res = await db.transaction(async (tx) => upsertReceivingOrder(tx, "EXT-1", body));
  assert.equal(res.created, true);
  assert.equal(res.changed, true);

  const ro = (
    await db.execute<{ status: string; supplier_id: string | null; ref_no: string }>(
      `SELECT status, supplier_id, ref_no FROM receiving_orders WHERE external_id='EXT-1'`
    )
  )[0];
  assert.equal(ro.status, "pending");
  assert.equal(ro.supplier_id, "s");
  assert.equal(ro.ref_no, "RO-1");

  const items = await db.execute<{
    qty: number;
    received_qty: number;
    box_id: string | null;
    date_code_norm: string | null;
    coo_norm: string | null;
    invoice_no: string;
    line_no: number;
  }>(`
    SELECT rii.qty, rii.received_qty, rii.box_id, rii.date_code_norm, rii.coo_norm, ri.invoice_no, rii.line_no
    FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id=rii.receiving_invoice_id
    ORDER BY ri.invoice_no, rii.line_no
  `);
  assert.deepEqual(Array.from(items), [
    { qty: 100, received_qty: 0, box_id: null, date_code_norm: "202401", coo_norm: "CN", invoice_no: "INV-1", line_no: 1 },
    { qty: 5, received_qty: 0, box_id: "B1", date_code_norm: null, coo_norm: null, invoice_no: "INV-1", line_no: 2 },
    { qty: 50, received_qty: 0, box_id: null, date_code_norm: null, coo_norm: null, invoice_no: "INV-2", line_no: 1 },
  ]);
  assert.equal(
    (await db.execute<{ c: number }>(`SELECT COUNT(*)::int AS c FROM parts`))[0].c,
    2
  );
  await assertInvariantsHold(db);
});

test("upsertReceivingOrder rejects a missing ref_no and a negative qty with 400", async () => {
  await assert.rejects(
    async () => {
      await db.transaction(async (tx) =>
        upsertReceivingOrder(tx, "E", { order: { ref_no: "" }, invoices: [] } as any)
      );
    },
    (e: any) => e.status === 400
  );
  await assert.rejects(
    async () => {
      await db.transaction(async (tx) =>
        upsertReceivingOrder(tx, "E2", {
          order: { ref_no: "R" },
          invoices: [
            { invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: -1 }] },
          ],
        } as any)
      );
    },
    (e: any) => e.status === 400
  );
});

test("re-PUT of an identical payload is a no-op (changed=false, updated_at unchanged)", async () => {
  const body: ReceivingPutBody = {
    order: { ref_no: "RO-1", delivery_date: "2026-07-20" },
    invoices: [
      {
        invoice_no: "INV-1",
        items: [{ line_no: 1, part_no: "ABO", qty: 100, date_code: "202401" }],
      },
    ],
  };
  const first = await db.transaction(async (tx) => upsertReceivingOrder(tx, "EXT-1", body));
  const stamp = (
    await db.execute<{ updated_at: string }>(
      `SELECT updated_at FROM receiving_orders WHERE id='${first.orderId}'`
    )
  )[0].updated_at;
  const itemStamp = (
    await db.execute<{ updated_at: string }>(`SELECT updated_at FROM receiving_invoice_items`)
  )[0].updated_at;
  const invoiceStamp = (
    await db.execute<{ updated_at: string }>(`SELECT updated_at FROM receiving_invoices`)
  )[0].updated_at;

  const second = await db.transaction(async (tx) => upsertReceivingOrder(tx, "EXT-1", body));
  assert.equal(second.created, false);
  assert.equal(second.changed, false);
  assert.equal(
    (
      await db.execute<{ updated_at: string }>(
        `SELECT updated_at FROM receiving_orders WHERE id='${first.orderId}'`
      )
    )[0].updated_at,
    stamp
  );
  assert.equal(
    (await db.execute<{ updated_at: string }>(`SELECT updated_at FROM receiving_invoice_items`))[0]
      .updated_at,
    itemStamp
  );
  assert.equal(
    (await db.execute<{ updated_at: string }>(`SELECT updated_at FROM receiving_invoices`))[0]
      .updated_at,
    invoiceStamp
  );
});

test("update adds a line, changes a qty (pending), and removes an untouched line", async () => {
  const v1: ReceivingPutBody = {
    order: { ref_no: "RO-1" },
    invoices: [
      {
        invoice_no: "INV-1",
        items: [
          { line_no: 1, part_no: "ABO", qty: 100 },
          { line_no: 2, part_no: "X1", qty: 5 },
        ],
      },
    ],
  };
  const first = await db.transaction(async (tx) => upsertReceivingOrder(tx, "EXT-1", v1));

  const v2: ReceivingPutBody = {
    order: { ref_no: "RO-1" },
    invoices: [
      {
        invoice_no: "INV-1",
        items: [
          { line_no: 1, part_no: "ABO", qty: 120 },
          { line_no: 3, part_no: "Z9", qty: 7 },
        ],
      },
    ],
  };
  const second = await db.transaction(async (tx) => upsertReceivingOrder(tx, "EXT-1", v2));
  assert.equal(second.created, false);
  assert.equal(second.changed, true);

  const rows = await db.execute<{
    line_no: number;
    qty: number;
    part_no: string;
  }>(`
    SELECT rii.line_no, rii.qty, p.part_no FROM receiving_invoice_items rii
    JOIN parts p ON p.id=rii.part_id JOIN receiving_invoices ri ON ri.id=rii.receiving_invoice_id
    WHERE ri.receiving_order_id='${first.orderId}' ORDER BY rii.line_no
  `);
  assert.deepEqual(Array.from(rows), [
    { line_no: 1, qty: 120, part_no: "ABO" },
    { line_no: 3, qty: 7, part_no: "Z9" },
  ]);
  await assertInvariantsHold(db);
});

test("in_hand: decreasing a line qty is 409", async () => {
  const v1: ReceivingPutBody = {
    order: { ref_no: "R" },
    invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 100 }] }],
  };
  const r = await db.transaction(async (tx) => upsertReceivingOrder(tx, "E", v1));
  await seedInHand(r.orderId);
  const v2: ReceivingPutBody = {
    order: { ref_no: "R" },
    invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 99 }] }],
  };
  await assert.rejects(
    async () => {
      await db.transaction(async (tx) => upsertReceivingOrder(tx, "E", v2));
    },
    (e: any) => e.status === 409
  );
});

test("in_hand: increasing a line qty is allowed", async () => {
  const v1: ReceivingPutBody = {
    order: { ref_no: "R" },
    invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 100 }] }],
  };
  const r = await db.transaction(async (tx) => upsertReceivingOrder(tx, "E", v1));
  await seedInHand(r.orderId);
  const v2: ReceivingPutBody = {
    order: { ref_no: "R" },
    invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 150 }] }],
  };
  const r2 = await db.transaction(async (tx) => upsertReceivingOrder(tx, "E", v2));
  assert.equal(r2.changed, true);
  assert.equal(
    (await db.execute<{ qty: number }>(`SELECT qty FROM receiving_invoice_items`))[0].qty,
    150
  );
});

test("in_hand: removing a line is 409", async () => {
  const v1: ReceivingPutBody = {
    order: { ref_no: "R" },
    invoices: [
      {
        invoice_no: "I",
        items: [
          { line_no: 1, part_no: "P", qty: 100 },
          { line_no: 2, part_no: "Q", qty: 5 },
        ],
      },
    ],
  };
  const r = await db.transaction(async (tx) => upsertReceivingOrder(tx, "E", v1));
  await seedInHand(r.orderId);
  const v2: ReceivingPutBody = {
    order: { ref_no: "R" },
    invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 100 }] }],
  };
  await assert.rejects(
    async () => {
      await db.transaction(async (tx) => upsertReceivingOrder(tx, "E", v2));
    },
    (e: any) => e.status === 409
  );
});

test("pending: removing a line that already has a receipt is 409", async () => {
  const v1: ReceivingPutBody = {
    order: { ref_no: "R" },
    invoices: [
      {
        invoice_no: "I",
        items: [
          { line_no: 1, part_no: "P", qty: 100 },
          { line_no: 2, part_no: "Q", qty: 5 },
        ],
      },
    ],
  };
  await db.transaction(async (tx) => upsertReceivingOrder(tx, "E", v1));
  await db.execute(
    `UPDATE receiving_invoice_items SET received_qty=1, available_qty=1 WHERE line_no=2`
  );
  const v2: ReceivingPutBody = {
    order: { ref_no: "R" },
    invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 100 }] }],
  };
  await assert.rejects(
    async () => {
      await db.transaction(async (tx) => upsertReceivingOrder(tx, "E", v2));
    },
    (e: any) => e.status === 409
  );
});

test.after(async () => {
  await sql.end();
});
