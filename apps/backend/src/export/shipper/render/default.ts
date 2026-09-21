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
    // (`invoice_no ctn_no` | part | qty), BOTTOM-aligned.
    //   live mode: allocations are per carton line — each allocation gets its
    //     own column (sequential across the block, in carton order); the qty
    //     sits on its carton's row, the order ref directly above, the
    //     customer two cells above. Block height = cartons + 2 when any
    //     carton has slots (no slots → the original max(items, 3) shape).
    //   finished mode: package slots can't pin to carton rows, so they
    //     overlay the block's last three rows (all customers / all refs /
    //     all qtys), height max(items, 3).
    // `totalBalance` (totalQty, balance) lands on the block's last row.
    function pushGroupBlock(
      partKey: string,
      blockItems: ShipperGroup["blockItems"],
      relatedSources: ShipperGroup["relatedSources"],
      allocs: ShipperSlot[],
      totalBalance: [number, number] | null
    ) {
      const perCarton = !finished && blockItems.some((item) => item.slots.length > 0);
      const height = perCarton ? blockItems.length + 2 : Math.max(blockItems.length, 3);
      const rows: (string | number)[][] = Array.from({ length: height }, () =>
        Array<string | number>(width).fill("")
      );
      blockItems.forEach((item, i) => {
        const row = rows[height - blockItems.length + i];
        row[0] = [item[firstColumnField], item.ctnNo].filter(Boolean).join(" ");
        row[1] = partKey;
        row[2] = item.qty;
      });
      if (perCarton) {
        let c = 0;
        blockItems.forEach((item, j) => {
          const r = height - blockItems.length + j;
          for (const a of item.slots.slice(0, slotCount - c)) {
            rows[r][4 + c] = a.qty;
            rows[r - 1][4 + c] = a.orderRef;
            rows[r - 2][4 + c] = a.customer;
            c++;
          }
        });
      } else {
        allocs.slice(0, slotCount).forEach((a, i) => {
          rows[height - 3][4 + i] = a.customer;
          rows[height - 2][4 + i] = a.orderRef;
          rows[height - 1][4 + i] = a.qty;
        });
      }
      // The related-source breakdown sits at the TOP of the block: column B
      // of the block's second row, free there whenever the block has header
      // rows above the cartons (live blocks with slots: height = cartons + 2;
      // single-carton no-slot blocks: carton on the last row of 3). Only a
      // no-slot block with 2+ cartons fills every row with a carton (col B =
      // part number) — there it falls back to col D of the height-2 row.
      if (relatedSources.length > 0) {
        const atTop = perCarton || blockItems.length === 1;
        rows[atTop ? 1 : height - 2][atTop ? 1 : 3] = formatRelatedSources(relatedSources);
      }
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
