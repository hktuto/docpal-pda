// PDA list-row display templates (spec
// docs/superpowers/specs/2026-09-21-pda-list-row-templates-design.md):
// mirror copy of apps/pda/utils/listRowTemplate.ts for the display-config
// live preview — the PDA app is the real consumer (list pages render rows
// through these templates); keep the two files in sync.

export type PdaListKey =
  | "receiving"
  | "picking"
  | "put-away"
  | "goods-verify"
  | "verify"
  | "measuring";

/** List keys addressable by pdaViewConfig.lists — the six template lists plus
 *  stock-search (spec 2026-10-04-pda-app-rewrite-design.md), labeling
 *  (spec 2026-10-28; never had a legacy pdaListTemplates entry) and
 *  label-printing (spec 2026-11-02). */
export type PdaViewListKey = PdaListKey | "labeling" | "label-printing" | "stock-search" | "packaging";

export const PDA_LIST_KEYS: PdaListKey[] = [
  "receiving",
  "picking",
  "put-away",
  "goods-verify",
  "verify",
  "measuring",
];

export interface PdaListFieldSpec {
  /** camelCase field on the list-row DTO. */
  field: string;
  /** date → YYYY-MM-DD; datetime → YYYY-MM-DD HH:mm (from an ISO string/Date). */
  kind?: "date" | "datetime";
  /** true = render only the first value of a comma-joined string. */
  first?: boolean;
}

/** snake_case token → row field, per list. The display-order keys double as
 *  the admin editor's placeholder chips. */
export const PDA_LIST_FIELDS: Record<PdaViewListKey, Record<string, PdaListFieldSpec>> = {
  receiving: {
    name: { field: "displayName" },
    batch_no: { field: "batchNo" },
    invoice_no: { field: "invoiceNos" },
    invoice_no_first: { field: "invoiceNos", first: true },
    supplier_code: { field: "supplierCode" },
    supplier_name: { field: "supplierName" },
    delivery_date: { field: "deliveryDate", kind: "date" },
    date_code: { field: "dateCode" },
    status: { field: "status" },
    org_id: { field: "orgId" },
    invoice_count: { field: "invoiceCount" },
    item_count: { field: "itemCount" },
    remaining_items: { field: "remainingItems" },
    pending_picking_orders: { field: "pendingPickingOrders" },
    assignee: { field: "assignee" },
  },
  picking: {
    order_no: { field: "orderNo" },
    status: { field: "status" },
    allocation_status: { field: "allocationStatus" },
    customer_code: { field: "customerCode" },
    po_no: { field: "poNo" },
    ship_to: { field: "shipTo" },
    delivery_date: { field: "deliveryDate", kind: "date" },
    item_count: { field: "itemCount" },
    total_qty: { field: "totalQty" },
    picked_qty: { field: "pickedQty" },
    working_by_name: { field: "workingByName" },
    org_id: { field: "orgId" },
    sub_inventory_code: { field: "subInventoryCode" },
    assignee: { field: "assignee" },
  },
  "put-away": {
    name: { field: "displayName" },
    batch_no: { field: "batchNo" },
    invoice_no: { field: "invoiceNos" },
    invoice_no_first: { field: "invoiceNos", first: true },
    supplier_code: { field: "supplierCode" },
    supplier_name: { field: "supplierName" },
    delivery_date: { field: "deliveryDate", kind: "date" },
    date_code: { field: "dateCode" },
    status: { field: "status" },
    org_id: { field: "orgId" },
    sub_inventory_code: { field: "subInventoryCode" },
    unboxed_items: { field: "unboxedItems" },
    received_items: { field: "receivedItems" },
    assignee: { field: "assignee" },
  },
  "goods-verify": {
    wcl_item_no: { field: "wclItemNo" },
    part_no: { field: "partNo" },
    shelf_code: { field: "shelfCode" },
    box_id: { field: "boxId" },
    task_date: { field: "taskDate" },
    expected_qty: { field: "expectedQty" },
    status: { field: "status" },
    verified_by: { field: "verifiedBy" },
    verified_at: { field: "verifiedAt", kind: "datetime" },
  },
  verify: {
    shipping_box_id: { field: "shippingBoxId" },
    box_status: { field: "boxStatus" },
    order_nos: { field: "orderNos" },
    destination_country: { field: "destinationCountry" },
    package_count: { field: "packageCount" },
    verify_verified_count: { field: "verifyVerifiedCount" },
    assignee: { field: "assignee" },
  },
  measuring: {
    box_id: { field: "boxId" },
    status: { field: "status" },
    order_nos: { field: "orderNos" },
    package_count: { field: "packageCount" },
    verified_count: { field: "verifiedCount" },
    assignee: { field: "assignee" },
  },
  // Labeling list (spec 2026-10-28): picking order fields + the live matched
  // label count (row field derived from labelMatches.length by the page).
  labeling: {
    order_no: { field: "orderNo" },
    picking_order_type: { field: "pickingOrderType" },
    customer_code: { field: "customerCode" },
    ship_to: { field: "shipTo" },
    delivery_date: { field: "deliveryDate", kind: "date" },
    item_count: { field: "itemCount" },
    total_qty: { field: "totalQty" },
    labelCount: { field: "labelCount" },
    assignee: { field: "assignee" },
  },
  // Label-printing list (spec 2026-11-02): same row shape as labeling.
  "label-printing": {
    order_no: { field: "orderNo" },
    picking_order_type: { field: "pickingOrderType" },
    customer_code: { field: "customerCode" },
    ship_to: { field: "shipTo" },
    delivery_date: { field: "deliveryDate", kind: "date" },
    item_count: { field: "itemCount" },
    total_qty: { field: "totalQty" },
    labelCount: { field: "labelCount" },
    assignee: { field: "assignee" },
  },
  // View-config only (no pdaListTemplates list): the stock-search part group.
  "stock-search": {
    wcl_item_no: { field: "wclItemNo" },
    part_no: { field: "partNo" },
    description: { field: "description" },
    on_hand_qty: { field: "onHandQty" },
  },
  // Packaging list (spec 2026-11-10): the order-keyed post-verify queue.
  packaging: {
    order_no: { field: "orderNo" },
    customer_code: { field: "customerCode" },
    po_no: { field: "poNo" },
    ship_to: { field: "shipTo" },
    box_count: { field: "boxCount" },
    package_count: { field: "packageCount" },
    assignee: { field: "assignee" },
  },
};

export type PdaListRow = Record<string, unknown>;

function formatValue(spec: PdaListFieldSpec, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (spec.kind === "date" || spec.kind === "datetime") {
    const iso = value instanceof Date ? value.toISOString() : String(value);
    return spec.kind === "date" ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
  }
  const text = String(value);
  return spec.first ? text.split(", ")[0] : text;
}

/** Render one template against a row; unknown [tokens] stay literal. */
export function formatListRowTemplate(fields: PdaListRow, template: string, listKey: PdaViewListKey): string {
  const catalog = PDA_LIST_FIELDS[listKey];
  return template.replace(/\[([^\]]*)\]/g, (whole, name: string) => {
    const spec = catalog[name];
    if (!spec) return whole;
    return formatValue(spec, fields[spec.field]);
  });
}

/** True when the render carries no letter/digit — i.e. every placeholder was
 *  empty and only separators/literals like " · " remain. Drives the title
 *  fallback and the meta-line collapse. */
export function hasListRowContent(rendered: string): boolean {
  return /[\p{L}\p{N}]/u.test(rendered);
}

/** Last-resort title when the (custom, then default) title template renders
 *  empty — a row never shows blank. */
export function primaryListRowId(listKey: PdaViewListKey, fields: PdaListRow): string {
  switch (listKey) {
    case "receiving":
      return String(fields.displayName ?? fields.batchNo ?? "");
    case "picking":
      return String(fields.orderNo ?? "");
    case "put-away":
      return String(fields.displayName ?? fields.batchNo ?? "");
    case "goods-verify":
      return String(fields.wclItemNo ?? fields.partNo ?? "");
    case "verify":
      return String(fields.shippingBoxId ?? "");
    case "measuring":
      return String(fields.boxId ?? "");
    case "labeling":
      return String(fields.orderNo ?? "");
    case "label-printing":
      return String(fields.orderNo ?? "");
    case "packaging":
      return String(fields.orderNo ?? "");
    case "stock-search":
      return String(fields.wclItemNo ?? fields.partNo ?? "");
  }
}

