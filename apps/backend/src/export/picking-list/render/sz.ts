// Picking-list SZ warehouse variant (WAREHOUSE_CODE=sz). The SZ layout does
// NOT merge picking items sharing a part number into one block — it prints
// one product row per picking-item line, each carrying the upstream
// order_no (additional_data passthrough) and line_number, with that line's
// own allocation rows beneath. Data assembly and the document model are
// shared with the default renderer; only the layout differs.
// Layout v1 — pending the real SZ sample workbook for fine-tuning (column
// order, widths, grouping); the per-line structure itself is final.
// Registered warehouse-scoped: wins over the default on the SZ instance
// only (see export/registry.ts + export/warehouse.ts).

import ExcelJS from "exceljs";
import { registerRenderer } from "../../registry.js";
import type { PickingListDocument, PickingListLine } from "../model.js";
import { orderLink, orderLinkQrPng } from "../../orderLink.js";

async function render(doc: PickingListDocument): Promise<{ fileName: string; buffer: Buffer }> {
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
    "Part No",
    "WCL Item No",
    "Order No",
    "Line No",
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

  const pushAllocRows = (base: (string | number)[], blank: (string | number)[], line: PickingListLine) => {
    let allocSum = 0;
    let first = true;
    for (const a of line.allocs) {
      const b = first ? base : blank;
      first = false;
      allocSum += a.qty;
      if (a.kind === "lot") {
        aoa.push([
          ...b,
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
          ...b,
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
    if (line.qty > allocSum) {
      aoa.push([...blank, "UNALLOCATED", "", "", "", "", "", "", line.qty - allocSum]);
    }
  };

  for (const [groupIdx, group] of doc.groups.entries()) {
    for (const line of group.lines) {
      const lineBase: (string | number)[] = [
        line.mfrPartNo ?? "",
        group.partNo,
        line.orderNo ?? "",
        line.lineNumber ?? "",
        line.qty,
        line.allocatedQty,
        line.pickedQty,
      ];
      const blankBase: (string | number)[] = ["", "", "", "", "", "", ""];
      if (line.allocs.length > 0) {
        pushAllocRows(lineBase, blankBase, line);
      } else {
        aoa.push([...lineBase, "(no allocation)", "", "", "", "", "", "", ""]);
      }
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
    20, // Part No
    26, // WCL Item No
    18, // Order No
    8, // Line No
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

  // Order-link QR in the header's top-right corner (same as the default
  // renderer). Scanning the QR on the PDA opens this picking order.
  const qrId = wb.addImage({
    base64: (await orderLinkQrPng(orderLink("picking", head.orderId))).toString("base64"),
    extension: "png",
  });
  ws.addImage(qrId, { tl: { col: 11, row: 0 }, ext: { width: 80, height: 80 }, editAs: "oneCell" });
  ws.getCell(11, 1).value = "Scan to open in PDA";

  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const fileName = `picking-list-${head.orderNo}.xlsx`;
  return { fileName, buffer: buf };
}

registerRenderer("picking-list", { render }, { warehouse: "sz" });
