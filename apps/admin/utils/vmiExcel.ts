/**
 * Client-side decoder for the VMI picking-order Excel (VMI_Template_*.xlsx,
 * spec 2026-11-09-vmi-picking-excel-upload-design.md).
 *
 * Pure AOA in (the output of `XLSX.utils.sheet_to_json(ws, {header: 1,
 * defval: null})` — the page does the XLSX.read), so this util never imports
 * the xlsx lib. Sheet layout: one header row (VMI Ref.No | Customer Code |
 * Customer Name | Ship To Address | Customer PO | PO Line | Customer Item |
 * Item | Qty | Sub Inventory, column order free) then data rows to the end;
 * rows sharing a VMI Ref.No group into one picking order (first-seen order).
 */

export interface VmiItemDraft {
  /** Customer Item cell (the customer's own item number) — carried into
   *  picking_items.additional_data.customerItem. */
  customerItem: string;
  /** Item cell — the parts key (wcl_item_no form, e.g. "KOA/TLR3APDTE L500F75"). */
  partNo: string;
  qty: string;
  /** PO Line cell (stringified; empty when the sheet leaves it blank). */
  lineNumber: string;
}

export interface VmiOrderDraft {
  /** VMI Ref.No — the group key and the order_no. */
  orderNo: string;
  customerCode: string;
  customerName: string;
  shipTo: string;
  poNo: string;
  /** Sub Inventory cell — the org_id: auto-set when the code matches exactly
   *  one org_info row, chosen from a dropdown when it matches several. */
  orgId: number | null;
  subInventoryCode: string;
  items: VmiItemDraft[];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/** Header/cell normalization: collapse inner whitespace, lower. */
function normHeader(value: unknown): string {
  return text(value).replace(/\s+/g, " ").toLowerCase();
}

const VMI_COLUMNS: Record<string, keyof (VmiItemDraft & VmiOrderDraft)> = {
  "vmi ref.no": "orderNo",
  "customer code": "customerCode",
  "customer name": "customerName",
  "ship to address": "shipTo",
  "customer po": "poNo",
  "po line": "lineNumber",
  "customer item": "customerItem",
  item: "partNo",
  qty: "qty",
  "sub inventory": "subInventoryCode",
};

/** Qty cell → positive integer, or null ("1,000" tolerated). */
export function vmiQty(value: string): number | null {
  const n = Number(text(value).replace(/,/g, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse the sheet AOA into per-VMI-Ref order drafts (throws when the sheet
 *  has no usable VMI header row). */
export function parseVmiAoa(aoa: unknown[][]): VmiOrderDraft[] {
  const rows = (aoa ?? []).filter((r) => Array.isArray(r));

  let headerIdx = -1;
  let colMap: (keyof (VmiItemDraft & VmiOrderDraft) | null)[] = [];
  for (let i = 0; i < rows.length; i++) {
    const map = rows[i].map((h) => VMI_COLUMNS[normHeader(h)] ?? null);
    if (map.includes("orderNo") && map.includes("partNo") && map.includes("qty") && map.includes("subInventoryCode")) {
      headerIdx = i;
      colMap = map;
      break;
    }
  }
  if (headerIdx < 0)
    throw new Error("Not a VMI sheet: header row needs VMI Ref.No / Item / Qty / Sub Inventory columns");

  const groups = new Map<string, VmiOrderDraft>();
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((cell) => text(cell) === "")) continue;
    const vals: Partial<Record<keyof (VmiItemDraft & VmiOrderDraft), string>> = {};
    for (let c = 0; c < colMap.length; c++) {
      const field = colMap[c];
      if (field) vals[field] = String(row[c] ?? "").trim();
    }
    // A row without a VMI Ref.No becomes its own flagged group (keyed by row
    // position so successive blank-ref rows do not merge).
    const ref = text(vals.orderNo);
    const key = ref === "" ? `#row${r + 1}` : ref;
    let draft = groups.get(key);
    if (!draft) {
      // shortcut: header fields come from the group's first row; later rows
      // differing in customer/PO/sub-inventory keep the first value. Upgrade
      // path: flag conflicts as issues.
      draft = {
        orderNo: ref,
        customerCode: text(vals.customerCode),
        customerName: text(vals.customerName),
        shipTo: text(vals.shipTo),
        poNo: text(vals.poNo),
        subInventoryCode: text(vals.subInventoryCode),
        orgId: null,
        items: [],
      };
      groups.set(key, draft);
    }
    draft.items.push({
      customerItem: text(vals.customerItem),
      partNo: text(vals.partNo),
      qty: text(vals.qty),
      lineNumber: text(vals.lineNumber),
    });
  }
  return [...groups.values()];
}

// --- upload data gate --------------------------------------------------------

export type VmiIssueCode = "noRef" | "noItem" | "invalidQty" | "unknownPart" | "noSubInv" | "subInvUnknown";

export interface VmiIssue {
  code: VmiIssueCode;
  /** The VMI Ref.No of the affected group (empty for a blank-ref group). */
  orderNo: string;
  /** The offending part key for unknownPart issues. */
  partNo?: string;
  /** The offending qty for invalidQty issues. */
  qty?: string;
  /** The offending Sub Inventory code for the subInv* issues. */
  subInv?: string;
}

/**
 * Check parsed drafts against the upload rules: every group has a Ref.No and
 * a Sub Inventory known to this instance (`orgIdsOfSubInv` — several orgs is
 * fine, the page then shows an org dropdown), and every item row has a
 * parts-master-known Item (`partKnown` reads the usePartsBrandCheck cache)
 * with a positive-integer Qty. Returns [] when the batch is safe to create.
 */
export function checkVmiDrafts(
  orders: VmiOrderDraft[],
  partKnown: (key: string) => boolean,
  orgIdsOfSubInv: (code: string) => number[]
): VmiIssue[] {
  const issues: VmiIssue[] = [];
  const seenUnknown = new Set<string>();
  for (const order of orders) {
    if (order.orderNo === "") issues.push({ code: "noRef", orderNo: "" });
    const code = order.subInventoryCode.trim();
    if (code === "") issues.push({ code: "noSubInv", orderNo: order.orderNo });
    else if (orgIdsOfSubInv(code).length === 0)
      issues.push({ code: "subInvUnknown", orderNo: order.orderNo, subInv: code });
    for (const item of order.items) {
      if (item.partNo === "") {
        issues.push({ code: "noItem", orderNo: order.orderNo });
        continue;
      }
      if (vmiQty(item.qty) === null) issues.push({ code: "invalidQty", orderNo: order.orderNo, qty: item.qty });
      const cacheKey = item.partNo.replace(/\s+/g, " ").toLowerCase();
      if (!partKnown(item.partNo) && !seenUnknown.has(cacheKey)) {
        seenUnknown.add(cacheKey);
        issues.push({ code: "unknownPart", orderNo: order.orderNo, partNo: item.partNo });
      }
    }
  }
  return issues;
}
