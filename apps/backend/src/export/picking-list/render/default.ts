// Picking-list default renderer (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md):
// the layout previously inline in src/routes/admin/pickingList.ts, moved
// verbatim — a flat one-row-per-allocation xlsx telling the picker, per
// item, where to get the allocated stock (shelf / box / lot) or which
// receiving order it is coming from (dock pick).
// The write step runs on ExcelJS (SheetJS cannot embed images) and stamps an
// order-link QR in the header (spec
// docs/superpowers/specs/2026-10-02-excel-order-barcode-scan-to-open-design.md).
// Self-registers as the "picking-list" default at module load.

import ExcelJS from "exceljs";
import { registerRenderer } from "../../registry.js";
import type { PickingListDocument } from "../model.js";
import { orderLink, orderLinkQrPng } from "../../orderLink.js";

export async function render(doc: PickingListDocument): Promise<{ fileName: string; buffer: Buffer }> {
  const { head } = doc;

  const aoa: (string | number)[][] = [];
  aoa.push([`Picking List — ${head.orderNo}`]);
  aoa.push(["Order No", head.orderNo]);
  aoa.push(["PO No", head.poNo ?? ""]);
  aoa.push(["Customer", head.customerCode ?? ""]);
  aoa.push(["Ship To", head.shipTo ?? ""]);
  aoa.push(["Org / Sub-Inventory", [head.orgId ?? "", head.subInventoryCode ?? ""].join(" / ")]);
  aoa.push(["Status", head.status]);
  aoa.push(["Allocation Status", head.allocationStatus]);
  aoa.push(["Remark", head.remark ?? ""]);
  aoa.push(["Generated At", doc.generatedAt]);
  aoa.push([]);
  aoa.push([
    "Part Number",
    "Item Qty",
    "Allocated Qty",
    "Picked Qty",
    "Source",
    "Location (Shelf)",
    "Box",
    "Date Code",
    "Lot Code",
    "COO / COW",
    "Source Org / Sub-Inv",
    "Alloc Qty",
  ]);

  for (const [groupIdx, group] of doc.groups.entries()) {
    const groupBase: (string | number)[] = [group.partNo, group.qty, group.allocatedQty, group.pickedQty];
    const blankBase: (string | number)[] = ["", "", "", ""];
    const allocs = group.allocs;
    if (allocs.length > 0) {
      let allocSum = 0;
      // Item columns only on the group's first row; continuation rows and the
      // UNALLOCATED footer carry just the allocation info.
      let first = true;
      for (const a of allocs) {
        const base = first ? groupBase : blankBase;
        first = false;
        allocSum += a.qty;
        if (a.kind === "lot") {
          aoa.push([
            ...base,
            "Shelf",
            a.shelfCode ?? "",
            a.boxId ?? "",
            a.dateCode ?? "",
            a.lotCode ?? "",
            [a.coo ?? "", a.cow ?? ""].join(" / "),
            [a.orgId ?? "", a.subInventoryCode ?? ""].join(" / "),
            a.qty,
          ]);
        } else {
          aoa.push([
            ...base,
            `Receiving ${a.receivingBatchNo ?? ""}`.trim(),
            "(dock)",
            "",
            "",
            "",
            "",
            "",
            a.qty,
          ]);
        }
      }
      if (group.qty > allocSum) {
        aoa.push([...blankBase, "UNALLOCATED", "", "", "", "", "", "", group.qty - allocSum]);
      }
    } else {
      aoa.push([...groupBase, "(no allocation)", "", "", "", "", "", "", ""]);
    }
    if (groupIdx < doc.groups.length - 1) aoa.push([]); // blank separator between part blocks
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Picking List");
  for (const row of aoa) {
    ws.addRow(row).eachCell({ includeEmpty: false }, (cell) => {
      if (typeof cell.value === "number") cell.numFmt = "#,##0";
    });
  }
  const colWidths = [
    26, // Part Number
    10, // Item Qty
    12, // Allocated Qty
    10, // Picked Qty
    18, // Source
    16, // Location (Shelf)
    12, // Box
    12, // Date Code
    12, // Lot Code
    12, // COO / COW
    18, // Source Org / Sub-Inv
    10, // Alloc Qty
  ];
  colWidths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  // Order-link QR in the header's top-right corner + caption on the blank
  // separator row (col A of row 11 is free). Scanning the QR on the PDA
  // opens this picking order.
  const qrId = wb.addImage({
    base64: (await orderLinkQrPng(orderLink("picking", head.orderId))).toString("base64"),
    extension: "png",
  });
  ws.addImage(qrId, { tl: { col: 8, row: 0 }, ext: { width: 80, height: 80 }, editAs: "oneCell" });
  ws.getCell(11, 1).value = "Scan to open in PDA";

  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const fileName = `picking-list-${head.orderNo}.xlsx`;
  return { fileName, buffer: buf };
}

registerRenderer("picking-list", { render });
