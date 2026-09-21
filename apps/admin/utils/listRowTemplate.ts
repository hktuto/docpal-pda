// PDA list-row display templates (spec
// docs/superpowers/specs/2026-09-21-pda-list-row-templates-design.md):
// mirror copy of apps/web/utils/listRowTemplate.ts for the display-config
// live preview — the PDA app is the real consumer (list pages render rows
// through these templates); keep the two files in sync.

export type PdaListKey =
  | "receiving"
  | "picking"
  | "put-away"
  | "goods-verify"
  | "verify"
  | "measuring";

export const PDA_LIST_KEYS: PdaListKey[] = [
  "receiving",
  "picking",
  "put-away",
  "goods-verify",
  "verify",
  "measuring",
];

export interface PdaListTemplate {
  title: string;
  meta: string;
}

export type PdaListTemplates = Record<PdaListKey, PdaListTemplate>;

/** Built-in defaults — reproduce the PDA's hardcoded list rows. Must match
 *  the backend defaults in apps/backend/src/config.ts. */
export const DEFAULT_PDA_LIST_TEMPLATES: PdaListTemplates = {
  receiving: { title: "[name]", meta: "[supplier_name] · [delivery_date]" },
  picking: { title: "[order_no]", meta: "[customer_code] · [po_no]" },
  "put-away": { title: "[batch_no]", meta: "[supplier_name]" },
  "goods-verify": { title: "[wcl_item_no]", meta: "[shelf_code] · [box_id]" },
  verify: { title: "[shipping_box_id]", meta: "[order_nos] · [destination_country]" },
  measuring: { title: "[box_id]", meta: "[order_nos]" },
};

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
export const PDA_LIST_FIELDS: Record<PdaListKey, Record<string, PdaListFieldSpec>> = {
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
  },
  measuring: {
    box_id: { field: "boxId" },
    status: { field: "status" },
    order_nos: { field: "orderNos" },
    package_count: { field: "packageCount" },
    verified_count: { field: "verifiedCount" },
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
export function formatListRowTemplate(fields: PdaListRow, template: string, listKey: PdaListKey): string {
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
function hasContent(rendered: string): boolean {
  return /[\p{L}\p{N}]/u.test(rendered);
}

/** Last-resort title when the (custom, then default) title template renders
 *  empty — a row never shows blank. */
function primaryId(listKey: PdaListKey, fields: PdaListRow): string {
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
  }
}

/** Render a list row's title or meta. Title: custom template → default
 *  template → primary id. Meta: returns "" when the render is empty — the
 *  caller hides the meta line. */
export function formatListRow(
  listKey: PdaListKey,
  slot: keyof PdaListTemplate,
  fields: PdaListRow,
  templates: PdaListTemplates = DEFAULT_PDA_LIST_TEMPLATES
): string {
  const rendered = formatListRowTemplate(fields, templates[listKey][slot], listKey);
  if (slot === "meta") return hasContent(rendered) ? rendered : "";
  if (hasContent(rendered)) return rendered;
  const fallback = formatListRowTemplate(fields, DEFAULT_PDA_LIST_TEMPLATES[listKey].title, listKey);
  return hasContent(fallback) ? fallback : primaryId(listKey, fields);
}
