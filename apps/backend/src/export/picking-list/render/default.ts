// Picking-list default renderer (spec
// docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md):
// the layout previously inline in src/routes/admin/pickingList.ts, moved
// verbatim — a flat one-row-per-allocation xlsx telling the picker, per
// item, where to get the allocated stock (shelf / box / lot) or which
// receiving order it is coming from (dock pick).
// Self-registers as the "picking-list" default at module load.

import * as XLSX from "xlsx";
import { registerRenderer } from "../../registry.js";
import type { PickingListDocument } from "../model.js";

export function render(doc: PickingListDocument): { fileName: string; buffer: Buffer } {
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

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith("!")) continue;
    const cell = ws[addr];
    if (cell.t === "n") cell.z = "#,##0";
  }
  ws["!cols"] = [
    { wch: 26 }, // Part Number
    { wch: 10 }, // Item Qty
    { wch: 12 }, // Allocated Qty
    { wch: 10 }, // Picked Qty
    { wch: 18 }, // Source
    { wch: 16 }, // Location (Shelf)
    { wch: 12 }, // Box
    { wch: 12 }, // Date Code
    { wch: 12 }, // Lot Code
    { wch: 12 }, // COO / COW
    { wch: 18 }, // Source Org / Sub-Inv
    { wch: 10 }, // Alloc Qty
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Picking List");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const fileName = `picking-list-${head.orderNo}.xlsx`;
  return { fileName, buffer: buf };
}

registerRenderer("picking-list", { render });
