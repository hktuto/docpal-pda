// Shipper default renderer (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md):
// the layout previously inline in src/routes/admin/receivingShipper.ts,
// moved verbatim — aoa row-building, column widths and XLSX.write.
// Exported as the factory makeShipperRenderer so config-style variants (see
// render/hcc.ts) can change the first column's header + field without
// forking the layout; the no-options default reproduces the original bytes.
// The default self-registers as the "shipper" renderer at module load.

import * as XLSX from "xlsx";
import { registerRenderer } from "../../registry.js";
import type { Renderer } from "../../types.js";
import type { ShipperDocument, ShipperGroup, ShipperSlot } from "../model.js";

export interface ShipperRendererOptions {
  firstColumnHeader?: string; // default "Invoice / Ctn"
  firstColumnField?: "invoiceNo" | "drawingNo"; // default "invoiceNo"
}

export function makeShipperRenderer(options?: ShipperRendererOptions): Renderer<ShipperDocument> {
  const firstColumnHeader = options?.firstColumnHeader ?? "Invoice / Ctn";
  const firstColumnField = options?.firstColumnField ?? "invoiceNo";

  function render(doc: ShipperDocument): { fileName: string; buffer: Buffer } {
    const { head, slotCount } = doc;
    const finished = doc.mode === "finished";

    const aoa: (string | number)[][] = [];
    const docTitle = finished ? "Finished Shipper" : "Shipper";
    aoa.push([`${docTitle} — ${head.batchNo}${head.supplierName ? ` (${head.supplierName})` : ""}`]);
    aoa.push([`Date: ${head.deliveryDate}`]);
    aoa.push([`Total Ctn: ${head.totalCtn ?? ""}`]);
    aoa.push([]);
    aoa.push([firstColumnHeader, "Part Number", "Qty", "Total Qty", ...Array(slotCount).fill("Customer"), "Balance"]);
    aoa.push(["", "Shelf", "", "", ...Array(slotCount).fill("Order No"), ""]);
    aoa.push([]);

    const width = 4 + slotCount + 1;

    // Merged part block: every carton of the part is an item row
    // (`invoice_no ctn_no` | part | qty), and the slot rows (customer / order
    // ref / slot qty) overlay the block's LAST THREE rows — spilling into
    // standalone rows above the item rows when the group has fewer than 3
    // cartons (1 carton → the original 3-row block). `totalBalance` (totalQty,
    // balance) lands on the block's last row.
    function pushGroupBlock(
      partKey: string,
      blockItems: ShipperGroup["blockItems"],
      relatedAllocated: number,
      allocs: ShipperSlot[],
      totalBalance: [number, number] | null
    ) {
      const height = Math.max(blockItems.length, 3);
      const rows: (string | number)[][] = Array.from({ length: height }, () =>
        Array<string | number>(width).fill("")
      );
      blockItems.forEach((item, i) => {
        const row = rows[height - blockItems.length + i];
        row[0] = [item[firstColumnField], item.ctnNo].filter(Boolean).join(" ");
        row[1] = partKey;
        row[2] = item.qty;
      });
      allocs.slice(0, slotCount).forEach((a, i) => {
        rows[height - 3][4 + i] = a.customer;
        rows[height - 2][4 + i] = a.orderRef;
        rows[height - 1][4 + i] = a.qty;
      });
      // The related-order allocated qty keeps the old shelf cell's seat:
      // column B for single-carton blocks; in merged blocks column B holds the
      // part on every row, so it moves to the Total Qty column of the
      // order-ref row (empty there — totals only land on the block's last row).
      if (relatedAllocated > 0) rows[height - 2][blockItems.length === 1 ? 1 : 3] = relatedAllocated;
      if (totalBalance) {
        rows[height - 1][3] = totalBalance[0];
        rows[height - 1][width - 1] = totalBalance[1];
      }
      aoa.push(...rows);
    }

    // A standalone 3-row block (customer names / order refs / one qty row) —
    // used for whole-order allocations that can't be pinned to a carton row.
    function pushBlock(
      partKey: string,
      invoiceCtn: string,
      allocs: ShipperSlot[],
      totalBalance: [number, number] | null
    ) {
      const pad = <T>(fn: (a: ShipperSlot) => T | ""): (T | "")[] =>
        Array.from({ length: slotCount }, (_, i) => (allocs[i] ? fn(allocs[i]) : ""));
      aoa.push(["", "", "", "", ...pad((a) => a.customer), ""]);
      aoa.push(["", "", "", "", ...pad((a) => a.orderRef), ""]);
      aoa.push([
        invoiceCtn,
        partKey,
        "",
        totalBalance ? totalBalance[0] : "",
        ...pad((a) => a.qty),
        totalBalance ? totalBalance[1] : "",
      ]);
    }

    doc.groups.forEach((group, gi) => {
      pushGroupBlock(
        group.partKey,
        group.blockItems,
        group.relatedAllocated,
        group.slots,
        // Live mode defers Total/Balance to the (order-level) closing block
        // when whole-order allocations exist; finished mode never has those.
        finished || !group.orderLevel ? [group.totalQty, group.totalQty - group.allocatedTotal] : null
      );

      // Whole-order (no ctn_no) allocations can't be pinned to a carton row —
      // they close the group as their own block so the Balance still adds up.
      if (group.orderLevel) {
        pushBlock(group.partKey, "(order-level)", group.orderLevel.slots, [
          group.totalQty,
          group.totalQty - group.allocatedTotal,
        ]);
      }

      if (gi < doc.groups.length - 1) aoa.push([]);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith("!")) continue;
      const cell = ws[addr];
      if (cell.t === "n") cell.z = "#,##0";
    }
    ws["!cols"] = [
      { wch: 20 }, // first column (Invoice / Ctn or variant header)
      { wch: 26 }, // Part Number
      { wch: 10 }, // Qty
      { wch: 10 }, // Total Qty
      ...Array.from({ length: slotCount }, () => ({ wch: 18 })), // Customer / Order No slots
      { wch: 10 }, // Balance
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, docTitle);
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const fileName = finished ? `finished-shipper-${head.batchNo}.xlsx` : `shipper-${head.batchNo}.xlsx`;
    return { fileName, buffer: buf };
  }

  return { render };
}

registerRenderer("shipper", makeShipperRenderer());
