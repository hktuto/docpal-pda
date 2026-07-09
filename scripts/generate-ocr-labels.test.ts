import { describe, it } from "vitest";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, inArray } from "drizzle-orm";
import * as schema from "~/db/schema";
import { createTablesSql } from "~/db/init";
import { seedDb } from "~/db/seed-precalc";

function generateLabel(item: {
  invoiceNo: string;
  poNo: string;
  poLine: string;
  partNo: string;
  qty: number;
  boxId: string;
  dateCode: string;
  lotCode: string;
  use: string;
}) {
  const dateCode = item.dateCode || "2544";
  const lotCode = item.lotCode || `9827${item.boxId}-P1`;
  const enc = `;${item.partNo}::Q:${item.qty}:T:${lotCode}:D:${dateCode}:KOA+${item.partNo}::::`;
  return `
        <div class="label label--koa">
          <div class="label__use">${item.use}</div>
          <div class="label__koa-rohs">RoHS</div>
          <div class="label__koa-order">${item.invoiceNo}</div>
          <div class="label__koa-po">PO: ${item.poNo} · Line ${item.poLine}</div>
          <div class="label__koa-field">
            <div class="label__koa-label">(P)CUSTOMER P/N:</div>
            <div class="label__koa-value">${item.partNo}</div>
            <svg class="barcode" aria-hidden="true"></svg>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(Q)QUANTITY:</div>
            <div class="label__koa-value label__qty">${item.qty}</div>
            <svg class="barcode" aria-hidden="true"></svg>
          </div>
          <div class="label__koa-row">
            <div class="label__koa-field">
              <div class="label__koa-label">(1T)TRACE CODE:</div>
              <div class="label__koa-value">${lotCode}</div>
              <svg class="barcode" aria-hidden="true"></svg>
            </div>
            <div class="label__koa-field">
              <div class="label__koa-label">(D)DATE CODE:</div>
              <div class="label__koa-value">${dateCode}</div>
              <svg class="barcode" aria-hidden="true"></svg>
            </div>
          </div>
          <div class="label__koa-field">
            <div class="label__koa-label">(1P)MPN:</div>
            <div class="label__koa-value">${item.partNo}</div>
            <svg class="barcode" aria-hidden="true"></svg>
          </div>
          <div class="label__koa-markings">
            <span>${item.partNo} F</span>
            <span>${item.boxId}</span>
          </div>
          <div class="label__koa-bottom">
            <div class="qr-placeholder" aria-hidden="true"></div>
            <div class="label__koa-enc">${enc}</div>
          </div>
          <div class="label__koa-footer">KOA MADE IN CN</div>
        </div>`;
}

describe("generate-ocr-labels", () => {
  it("writes public/ocr-labels.html from current receiving items", async () => {
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(createTablesSql);
    const db = drizzle(pg, { schema });

    await seedDb(db);

    const receivingOrder = await db.query.receivingOrders.findFirst({
      where: eq(schema.receivingOrders.refNo, "04958166"),
    });
    if (!receivingOrder) throw new Error("Receiving order 04958166 not found");

    const invoices = await db.query.receivingInvoices.findMany({
      where: eq(schema.receivingInvoices.receivingOrderId, receivingOrder.id),
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

    const allLabels = items.map((item, index) =>
      generateLabel({
        invoiceNo: invoiceNoById.get(item.receivingInvoiceId) ?? "",
        poNo: item.poNo ?? "",
        poLine: item.poLine ?? "",
        partNo: partNoById.get(item.partId) ?? item.partId,
        qty: item.qty,
        boxId: item.boxId ?? "",
        dateCode: item.dateCode ?? "",
        lotCode: item.lotCode ?? "",
        use: `Item ${index + 1}`,
      })
    );

    // Pick labels for a sample picking order (first one)
    const firstPickingOrder = await db.query.pickingOrders.findFirst({
      orderBy: (po, { asc }) => [asc(po.refNo)],
    });

    let pickingLabels: string[] = [];
    if (firstPickingOrder) {
      const pickingItems = await db.query.pickingItems.findMany({
        where: eq(schema.pickingItems.pickingOrderId, firstPickingOrder.id),
      });
      const pickingItemIds = pickingItems.map((pi) => pi.id);
      const allocations = await db.query.allocations.findMany({
        where: inArray(schema.allocations.pickingItemId, pickingItemIds),
      });
      const allocatedReceivingItemIds = allocations
        .map((a) => a.receivingInvoiceItemId)
        .filter((id): id is string => !!id);
      const allocatedItems = items.filter((item) =>
        allocatedReceivingItemIds.includes(item.id)
      );
      pickingLabels = allocatedItems.map((item) =>
        generateLabel({
          invoiceNo: invoiceNoById.get(item.receivingInvoiceId) ?? "",
          poNo: item.poNo ?? "",
          poLine: item.poLine ?? "",
          partNo: partNoById.get(item.partId) ?? item.partId,
          qty: item.qty,
          boxId: item.boxId ?? "",
          dateCode: item.dateCode ?? "",
          lotCode: item.lotCode ?? "",
          use: `${firstPickingOrder.refNo}`,
        })
      );
    }

    const remainingLabels = items
      .filter(
        (item) =>
          !pickingLabels.some((label) => label.includes(`PO: ${item.poNo} · Line ${item.poLine}`))
      )
      .slice(0, 8)
      .map((item) =>
        generateLabel({
          invoiceNo: invoiceNoById.get(item.receivingInvoiceId) ?? "",
          poNo: item.poNo ?? "",
          poLine: item.poLine ?? "",
          partNo: partNoById.get(item.partId) ?? item.partId,
          qty: item.qty,
          boxId: item.boxId ?? "",
          dateCode: item.dateCode ?? "",
          lotCode: item.lotCode ?? "",
          use: "Put-away",
        })
      );

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Warehouse PDA — Receiving Labels (04958166)</title>
  <style>
    :root {
      --bg: #ffffff;
      --text: #111111;
      --border: #000000;
      --muted: #555555;
      --accent: #2563eb;
      --accent-bg: #eff6ff;
      --carton: #c7a87e;
      --success: #15803d;
      --success-bg: #f0fdf4;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 1rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      background-color: var(--carton);
      background-image:
        repeating-linear-gradient(45deg, transparent, transparent 12px, rgba(0, 0, 0, 0.04) 12px, rgba(0, 0, 0, 0.04) 24px),
        repeating-linear-gradient(-45deg, transparent, transparent 12px, rgba(255, 255, 255, 0.06) 12px, rgba(255, 255, 255, 0.06) 24px);
      color: var(--text);
    }

    .no-print {
      max-width: 900px;
      margin: 0 auto 1.5rem;
    }

    h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
    .subtitle { margin: 0 0 1rem; color: var(--muted); font-size: 0.875rem; }

    .container {
      max-width: 900px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .section {
      background: var(--bg);
      border: 2px solid var(--border);
      padding: 1rem;
      box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.12);
    }

    .section__header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid #e5e7eb;
    }

    .section__title {
      font-size: 1.1rem;
      font-weight: bold;
      margin: 0;
      flex: 1;
    }

    .section__body p {
      margin: 0 0 0.5rem;
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.5;
    }

    .section__labels {
      margin-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .label {
      background: var(--bg);
      border: 3px solid var(--border);
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      min-height: 220px;
      box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.15);
      position: relative;
      overflow: hidden;
    }

    .label__use {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      font-size: 0.7rem;
      color: var(--muted);
      background: #f3f4f6;
      padding: 0.2rem 0.45rem;
      border: 1px solid #e5e7eb;
      z-index: 1;
    }

    .label__qty {
      font-size: 2.2rem;
      font-weight: bold;
      line-height: 1;
      color: var(--accent);
    }

    .barcode {
      height: 28px;
      width: 100%;
      display: block;
    }

    .barcode svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    .qr-placeholder {
      width: 64px;
      height: 64px;
      flex-shrink: 0;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Crect fill='%23fff' width='80' height='80'/%3E%3Cg fill='%23000'%3E%3Crect x='4' y='4' width='22' height='22'/%3E%3Crect x='8' y='8' width='14' height='14' fill='%23fff'/%3E%3Crect x='11' y='11' width='8' height='8'/%3E%3Crect x='54' y='4' width='22' height='22'/%3E%3Crect x='58' y='8' width='14' height='14' fill='%23fff'/%3E%3Crect x='61' y='11' width='8' height='8'/%3E%3Crect x='4' y='54' width='22' height='22'/%3E%3Crect x='8' y='58' width='14' height='14' fill='%23fff'/%3E%3Crect x='11' y='61' width='8' height='8'/%3E%3Crect x='30' y='4' width='6' height='6'/%3E%3Crect x='40' y='4' width='6' height='6'/%3E%3Crect x='34' y='14' width='6' height='6'/%3E%3Crect x='44' y='14' width='6' height='6'/%3E%3Crect x='30' y='24' width='6' height='6'/%3E%3Crect x='40' y='24' width='6' height='6'/%3E%3Crect x='50' y='30' width='6' height='6'/%3E%3Crect x='60' y='34' width='6' height='6'/%3E%3Crect x='30' y='34' width='6' height='6'/%3E%3Crect x='4' y='34' width='6' height='6'/%3E%3Crect x='14' y='40' width='6' height='6'/%3E%3Crect x='24' y='44' width='6' height='6'/%3E%3Crect x='40' y='40' width='6' height='6'/%3E%3Crect x='50' y='44' width='6' height='6'/%3E%3Crect x='64' y='44' width='6' height='6'/%3E%3Crect x='30' y='54' width='6' height='6'/%3E%3Crect x='44' y='54' width='6' height='6'/%3E%3Crect x='54' y='58' width='6' height='6'/%3E%3Crect x='64' y='64' width='6' height='6'/%3E%3Crect x='34' y='64' width='6' height='6'/%3E%3Crect x='44' y='70' width='6' height='6'/%3E%3Crect x='54' y='70' width='6' height='6'/%3E%3Crect x='70' y='70' width='6' height='6'/%3E%3C/g%3E%3C/svg%3E");
      background-size: contain;
      background-repeat: no-repeat;
      background-position: center;
    }

    /* KOA */
    .label--koa { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    .label--koa .label__koa-rohs { position: absolute; top: 0.75rem; right: 0.75rem; font-size: 1.2rem; font-weight: bold; font-family: Arial, Helvetica, sans-serif; }
    .label--koa .label__koa-order { font-size: 1rem; font-weight: bold; }
    .label--koa .label__koa-po { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem; }
    .label--koa .label__koa-field { display: flex; flex-direction: column; gap: 0.1rem; }
    .label--koa .label__koa-row { display: grid; grid-template-columns: 1.2fr 1fr; gap: 1rem; }
    .label--koa .label__koa-label { font-size: 0.85rem; font-weight: bold; letter-spacing: 0.02em; }
    .label--koa .label__koa-value { font-size: 1.35rem; font-weight: bold; }
    .label--koa .label__qty { font-size: 2rem; color: var(--accent); }
    .label--koa .label__koa-markings { display: flex; justify-content: space-between; font-size: 0.95rem; font-weight: bold; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd; padding: 0.35rem 0; margin: 0.2rem 0; }
    .label--koa .label__koa-bottom { display: flex; align-items: center; gap: 1rem; margin-top: 0.25rem; }
    .label--koa .label__koa-enc { font-size: 0.65rem; color: var(--muted); word-break: break-all; flex: 1; line-height: 1.3; }
    .label--koa .label__koa-footer { text-align: right; font-weight: bold; font-size: 0.8rem; margin-top: auto; }

    @media print {
      body { background: var(--bg); padding: 0; }
      .no-print { display: none; }
      .container { max-width: none; }
      .section { border: none; box-shadow: none; padding: 0; page-break-inside: avoid; }
      .section__header { border-bottom: 1px solid #000; }
      .label { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <h1>Warehouse PDA — Receiving Labels (04958166)</h1>
    <p class="subtitle">Labels generated from the current WCL receiving order <strong>04958166</strong> (${items.length} invoice items across ${invoices.length} invoices). Print this page and scan labels in the app flows.</p>
  </div>

  <div class="container">
    <section class="section" id="picking-labels">
      <div class="section__header">
        <h2 class="section__title">Sample picking labels — ${firstPickingOrder?.refNo ?? "first picking order"}</h2>
      </div>
      <div class="section__body">
        <p>These labels match the first picking order allocated against receiving order 04958166.</p>
      </div>
      <div class="section__labels">
${pickingLabels.join("\n")}
      </div>
    </section>

    <section class="section" id="putaway-labels">
      <div class="section__header">
        <h2 class="section__title">Sample put-away labels</h2>
      </div>
      <div class="section__body">
        <p>Additional receiving invoice items that can be scanned during put-away.</p>
      </div>
      <div class="section__labels">
${remainingLabels.join("\n")}
      </div>
    </section>

    <section class="section" id="all-labels">
      <div class="section__header">
        <h2 class="section__title">All receiving items</h2>
      </div>
      <div class="section__body">
        <p>Complete set of labels for every invoice item in receiving order 04958166.</p>
      </div>
      <div class="section__labels">
${allLabels.join("\n")}
      </div>
    </section>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
  <script>
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll('.label__koa-field').forEach(function (field) {
        var valueEl = field.querySelector('.label__koa-value');
        var barcodeEl = field.querySelector('.barcode');
        if (valueEl && barcodeEl) {
          var value = valueEl.textContent.trim();
          try {
            JsBarcode(barcodeEl, value, {
              format: 'CODE128',
              width: 1.5,
              height: 28,
              displayValue: false,
              margin: 0,
              background: 'transparent'
            });
          } catch (e) {
            barcodeEl.textContent = '';
          }
        }
      });

      document.querySelectorAll('.label--koa').forEach(function (label) {
        var encEl = label.querySelector('.label__koa-enc');
        var qrEl = label.querySelector('.qr-placeholder');
        if (encEl && qrEl) {
          var value = encEl.textContent.trim();
          QRCode.toString(value, { type: 'svg', width: 64, margin: 0, errorCorrectionLevel: 'M' })
            .then(function (svg) {
              qrEl.innerHTML = svg;
              var svgEl = qrEl.querySelector('svg');
              if (svgEl) {
                svgEl.setAttribute('width', '64');
                svgEl.setAttribute('height', '64');
              }
            })
            .catch(function () {
              qrEl.textContent = '';
            });
        }
      });
    });
  </script>
</body>
</html>`;

    fs.writeFileSync("public/ocr-labels.html", html);
  });
});
