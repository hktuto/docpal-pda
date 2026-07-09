import { describe, it } from "vitest";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { inArray } from "drizzle-orm";
import * as schema from "~/db/schema";
import { createTablesSql } from "~/db/init";
import { seedDb } from "~/db/seed-precalc";

function encodeKoaQty(qty: number): string {
  let zeros = 0;
  let value = qty;
  while (value % 10 === 0 && value > 0) {
    value /= 10;
    zeros++;
  }
  return `${value}${zeros}`;
}

interface LabelItem {
  invoiceNo: string;
  poNo: string;
  poLine: string;
  partNo: string;
  qty: number;
  boxId: string;
  dateCode: string;
  traceCode: string;
  unknown: string;
  fullName: string;
  qrValue: string;
}

describe("generate-labels-data", () => {
  it("writes public/labels-data.json from current receiving items", async () => {
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(createTablesSql);
    const db = drizzle(pg, { schema });

    await seedDb(db);

    const receivingOrder = await db.query.receivingOrders.findFirst({
      where: (ro, { eq }) => eq(ro.refNo, "04958166"),
    });
    if (!receivingOrder) throw new Error("Receiving order 04958166 not found");

    const invoices = await db.query.receivingInvoices.findMany({
      where: (ri, { eq }) => eq(ri.receivingOrderId, receivingOrder.id),
      orderBy: (ri, { asc }) => [asc(ri.invoiceNo)],
    });
    const invoiceIds = invoices.map((i) => i.id);
    const invoiceNoById = new Map(invoices.map((i) => [i.id, i.invoiceNo]));

    const items = await db.query.receivingInvoiceItems.findMany({
      where: inArray(schema.receivingInvoiceItems.receivingInvoiceId, invoiceIds),
      orderBy: (rii, { asc }) => [asc(rii.receivingInvoiceId), asc(rii.poNo), asc(rii.poLine)],
    });

    const partIds = [...new Set(items.map((i) => i.partId))];
    const parts = await db.query.parts.findMany({
      where: inArray(schema.parts.id, partIds),
    });
    const partNoById = new Map(parts.map((p) => [p.id, p.partNo]));

    const labels: LabelItem[] = items.map((item, index) => {
      const partNo = partNoById.get(item.partId) ?? item.partId;
      const invoiceNo = invoiceNoById.get(item.receivingInvoiceId) ?? "";
      const qtyEncoding = encodeKoaQty(item.qty);
      const dateCode = item.dateCode || "2544";
      const traceCode = item.lotCode || `9827${String(index + 1).padStart(3, "0")}`;
      const unknown = "602";
      const fullName = `KOA+${partNo}`;
      const qrValue = `:${partNo}::${qtyEncoding}:X:${traceCode}:${unknown}:${fullName}::::`;

      return {
        invoiceNo,
        poNo: item.poNo ?? "",
        poLine: item.poLine ?? "",
        partNo,
        qty: item.qty,
        boxId: item.boxId ?? "",
        dateCode,
        traceCode,
        unknown,
        fullName,
        qrValue,
      };
    });

    fs.writeFileSync(
      "public/labels-data.json",
      JSON.stringify(
        {
          receivingOrderNo: "04958166",
          invoiceCount: invoices.length,
          itemCount: labels.length,
          generatedAt: new Date().toISOString(),
          labels,
        },
        null,
        2
      )
    );
  });
});
