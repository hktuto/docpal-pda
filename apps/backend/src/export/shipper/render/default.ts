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

    // `qty@shelf/box` entries joined ", " — shelf NULL renders as `dock`
    // (receiving/dock sources), box omitted when NULL.
    function formatRelatedSources(sources: ShipperGroup["relatedSources"]): string {
      return sources
        .map((s) => `${s.qty}@${s.shelfCode ?? "dock"}${s.boxId ? `/${s.boxId}` : ""}`)
        .join(", ");
    }

    // Merged part block: every carton of the part is an item row
    // (`invoice_no ctn_no` | part | qty), BOTTOM-aligned; slot i stacks
    // vertically in its own column (customer / order ref / qty on rows
    // i, i+1, i+2), so slots cascade diagonally from the block top. Merged
    // slots are concatenated per carton in carton order (data.ts), so a
    // slot's qty lands on/near the row of the carton it was allocated from.
    // Blocks grow with slot overflow: height = max(items, slots) + 2 (no
    // slots → the original max(items, 3) shape). `totalBalance` (totalQty,
    // balance) lands on the block's last row.
    function pushGroupBlock(
      partKey: string,
      blockItems: ShipperGroup["blockItems"],
      relatedSources: ShipperGroup["relatedSources"],
      allocs: ShipperSlot[],
      totalBalance: [number, number] | null
    ) {
      const height =
        allocs.length === 0
          ? Math.max(blockItems.length, 3)
          : Math.max(blockItems.length, allocs.length) + 2;
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
        rows[i][4 + i] = a.customer;
        rows[i + 1][4 + i] = a.orderRef;
        rows[i + 2][4 + i] = a.qty;
      });
      // The related-source breakdown keeps the old shelf cell's seat:
      // column B for single-carton blocks; in merged blocks column B holds the
      // part on every row, so it moves to the Total Qty column of the
      // height-2 row (empty there — totals only land on the block's last row).
      if (relatedSources.length > 0) {
        rows[height - 2][blockItems.length === 1 ? 1 : 3] = formatRelatedSources(relatedSources);
      }
      if (totalBalance) {
        rows[height - 1][3] = totalBalance[0];
        rows[height - 1][width - 1] = totalBalance[1];
      }
      aoa.push(...rows);
    }

    // A standalone closing block for whole-order allocations that can't be
    // pinned to a carton row — same diagonal cascade as the group blocks
    // (height = slots + 2); the last row carries the `(order-level)` label,
    // partKey and Total/Balance so it still adds up.
    function pushBlock(
      partKey: string,
      invoiceCtn: string,
      allocs: ShipperSlot[],
      totalBalance: [number, number] | null
    ) {
      const height = allocs.length + 2;
      const rows: (string | number)[][] = Array.from({ length: height }, () =>
        Array<string | number>(width).fill("")
      );
      allocs.slice(0, slotCount).forEach((a, i) => {
        rows[i][4 + i] = a.customer;
        rows[i + 1][4 + i] = a.orderRef;
        rows[i + 2][4 + i] = a.qty;
      });
      const last = rows[height - 1]!;
      last[0] = invoiceCtn;
      last[1] = partKey;
      if (totalBalance) {
        last[3] = totalBalance[0];
        last[width - 1] = totalBalance[1];
      }
      aoa.push(...rows);
    }

    doc.groups.forEach((group, gi) => {
      pushGroupBlock(
        group.partKey,
        group.blockItems,
        group.relatedSources,
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
