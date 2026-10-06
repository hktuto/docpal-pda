// PDA view config (flow-config key pdaViewConfig, resolved via GET /config
// viewConfig; spec docs/superpowers/specs/2026-10-04-pda-app-rewrite-design.md):
// per-list {title, meta[1-2], chip} row rendering + per-detail-page field
// allow-lists. Framework-free — apps/admin keeps a mirror copy
// (apps/admin/utils/viewConfig.ts) for the display-config editor. Must match
// the backend defaults/catalogs in apps/backend/src/config.ts.

import {
  PDA_LIST_KEYS,
  formatListRowTemplate,
  hasListRowContent,
  primaryListRowId,
  type PdaListRow,
  type PdaViewListKey,
} from "./listRowTemplate";

export const PDA_VIEW_LIST_KEYS: PdaViewListKey[] = [...PDA_LIST_KEYS, "stock-search"];

export interface PdaListViewConfig {
  title: string;
  /** 1–2 meta line templates. */
  meta: string[];
  /** Which field feeds the inline status chip ("none" = hide). */
  chip: string;
}

export type PdaDetailGrouping = "invoice" | "carton" | "part-no";

export const PDA_DETAIL_GROUPINGS: PdaDetailGrouping[] = ["invoice", "carton", "part-no"];

export interface PdaReceivingDetailViewConfig {
  defaultGrouping: PdaDetailGrouping;
  itemFields: string[];
  expandedFields: string[];
}

export interface PdaDetailViewConfig {
  itemFields: string[];
  expandedFields: string[];
}

export interface PdaViewConfig {
  lists: Record<PdaViewListKey, PdaListViewConfig>;
  receivingDetail: PdaReceivingDetailViewConfig;
  pickingDetail: PdaDetailViewConfig;
  putAwayDetail: PdaDetailViewConfig;
}

/** Chip field catalog per list ("none" = no chip rendered). Mirrors
 *  PDA_LIST_CHIP_FIELDS in apps/backend/src/config.ts. */
export const PDA_LIST_CHIP_FIELDS: Record<PdaViewListKey, string[]> = {
  receiving: ["status", "remaining_items", "pending_picking_orders", "none"],
  picking: ["status", "allocation_status", "working_by_name", "none"],
  "put-away": ["status", "unboxed_items", "received_items", "none"],
  "goods-verify": ["status", "verified_by", "none"],
  verify: ["box_status", "package_count", "verify_verified_count", "none"],
  measuring: ["status", "package_count", "verified_count", "none"],
  "stock-search": ["none"],
};

export type PdaDetailPageKey = "receivingDetail" | "pickingDetail" | "putAwayDetail";

/** Item/expanded field allow-lists per detail page. Mirrors PDA_DETAIL_FIELDS
 *  in apps/backend/src/config.ts. */
export const PDA_DETAIL_FIELDS: Record<PdaDetailPageKey, string[]> = {
  receivingDetail: [
    "wcl_item_no", "part_no", "expected_qty", "received_qty", "po_no", "po_line",
    "box_id", "date_code", "lot_code", "coo", "cow",
    "reserved_qty", "picked_qty", "put_away_qty", "available_qty",
  ],
  pickingDetail: [
    "wcl_item_no", "part_no", "qty", "picked_qty", "allocated_qty", "status",
    "shelf_code", "box_id", "date_code", "lot_code", "coo", "cow", "source",
  ],
  putAwayDetail: [
    "wcl_item_no", "part_no", "expected_qty", "received_qty", "remaining_qty",
    "po_no", "box_id", "date_code", "lot_code", "coo", "cow", "suggested_shelf",
  ],
};

/** Built-in defaults — reproduce the PDA's current rendering. Must match
 *  defaultPdaViewConfig() in apps/backend/src/config.ts. */
export const DEFAULT_PDA_VIEW_CONFIG: PdaViewConfig = {
  lists: {
    receiving: { title: "[name]", meta: ["[supplier_name] · [delivery_date]"], chip: "status" },
    picking: { title: "[order_no]", meta: ["[customer_code] · [po_no]"], chip: "status" },
    "put-away": { title: "[batch_no]", meta: ["[supplier_name]"], chip: "status" },
    "goods-verify": { title: "[wcl_item_no]", meta: ["[shelf_code] · [box_id]"], chip: "status" },
    verify: { title: "[shipping_box_id]", meta: ["[order_nos] · [destination_country]"], chip: "box_status" },
    measuring: { title: "[box_id]", meta: ["[order_nos]"], chip: "status" },
    "stock-search": { title: "[wcl_item_no]", meta: ["[part_no]"], chip: "none" },
  },
  receivingDetail: {
    defaultGrouping: "invoice",
    itemFields: ["wcl_item_no", "expected_qty", "po_no", "po_line"],
    expandedFields: [
      "expected_qty", "box_id", "po_line", "reserved_qty", "picked_qty",
      "put_away_qty", "available_qty", "date_code", "lot_code", "coo", "cow",
    ],
  },
  pickingDetail: {
    itemFields: ["wcl_item_no", "qty", "picked_qty"],
    expandedFields: ["allocated_qty", "shelf_code", "box_id", "date_code", "lot_code", "coo", "cow", "source"],
  },
  putAwayDetail: {
    itemFields: ["wcl_item_no", "expected_qty", "remaining_qty", "suggested_shelf"],
    expandedFields: ["received_qty", "po_no", "box_id", "date_code", "lot_code", "coo", "cow"],
  },
};

export function defaultPdaViewConfig(): PdaViewConfig {
  return JSON.parse(JSON.stringify(DEFAULT_PDA_VIEW_CONFIG)) as PdaViewConfig;
}

// ------------------------------------------------------------------
// List row rendering (title / meta / chip)
// ------------------------------------------------------------------

export interface PdaListRowView {
  title: string;
  /** 0–2 rendered meta lines (empty renders dropped). */
  meta: string[];
  chip: string;
}

/** Render a list row's title + meta lines through the view config. Title
 *  falls back to the default title template, then the row's primary id; meta
 *  lines whose render is empty are dropped. */
export function viewListRow(
  listKey: PdaViewListKey,
  row: PdaListRow,
  view: PdaViewConfig = DEFAULT_PDA_VIEW_CONFIG
): PdaListRowView {
  const cfg = view.lists[listKey] ?? DEFAULT_PDA_VIEW_CONFIG.lists[listKey];
  const rendered = formatListRowTemplate(row, cfg.title, listKey);
  let title = rendered;
  if (!hasListRowContent(title)) {
    const fallback = formatListRowTemplate(row, DEFAULT_PDA_VIEW_CONFIG.lists[listKey].title, listKey);
    title = hasListRowContent(fallback) ? fallback : primaryListRowId(listKey, row);
  }
  const meta = cfg.meta
    .map((template) => formatListRowTemplate(row, template, listKey))
    .filter((line) => hasListRowContent(line))
    .slice(0, 2);
  return { title, meta, chip: cfg.chip };
}

/** Which statusLabel method + status code a status chip renders through. */
export type ListChipSpec =
  | {
      kind: "status";
      status: string;
      labelFn: "receiving" | "picking" | "putAway" | "goodsVerify" | "box" | "verify" | "measuring" | "allocation";
    }
  | { kind: "label"; labelKey: string; params?: Record<string, unknown>; cls?: string }
  | null;

const STATUS_LABEL_FN: Record<PdaViewListKey, NonNullable<Extract<ListChipSpec, { kind: "status" }>["labelFn"]>> = {
  receiving: "receiving",
  picking: "picking",
  "put-away": "putAway",
  "goods-verify": "goodsVerify",
  verify: "box",
  measuring: "box",
  "stock-search": "receiving",
};

function num(row: PdaListRow, field: string): number {
  const v = row[field];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

/** Resolve the configured chip field of a list row to a render spec (null =
 *  hide the chip). `statusLabelFn` overrides the default status-label method
 *  (the put-away list shows receiving statuses in candidate mode). */
export function viewListChip(
  listKey: PdaViewListKey,
  row: PdaListRow,
  view: PdaViewConfig = DEFAULT_PDA_VIEW_CONFIG,
  opts: { statusLabelFn?: NonNullable<Extract<ListChipSpec, { kind: "status" }>["labelFn"]> } = {}
): ListChipSpec {
  const chip = (view.lists[listKey] ?? DEFAULT_PDA_VIEW_CONFIG.lists[listKey]).chip;
  if (!chip || chip === "none") return null;
  const statusFn = opts.statusLabelFn ?? STATUS_LABEL_FN[listKey];
  switch (chip) {
    case "status":
    case "box_status": {
      const status = String(row[chip === "box_status" ? "boxStatus" : "status"] ?? "");
      return status ? { kind: "status", status, labelFn: statusFn } : null;
    }
    case "allocation_status": {
      const status = String(row.allocationStatus ?? "");
      return status ? { kind: "status", status, labelFn: "allocation" } : null;
    }
    case "working_by_name": {
      const name = row.workingByName;
      return name ? { kind: "label", labelKey: "picking.lockedBy", params: { name }, cls: "badge--pending" } : null;
    }
    case "verified_by": {
      const name = row.verifiedBy;
      return name ? { kind: "label", labelKey: "viewConfig.chips.verifiedBy", params: { name }, cls: "badge--clear" } : null;
    }
    case "remaining_items":
      return num(row, "remainingItems") > 0
        ? { kind: "label", labelKey: "receiving.remaining", params: { count: num(row, "remainingItems") }, cls: "badge--pending" }
        : null;
    case "pending_picking_orders":
      return num(row, "pendingPickingOrders") > 0
        ? { kind: "label", labelKey: "viewConfig.chips.pendingPickingOrders", params: { count: num(row, "pendingPickingOrders") }, cls: "badge--pending" }
        : null;
    case "unboxed_items":
      return num(row, "unboxedItems") > 0
        ? { kind: "label", labelKey: "putAway.unboxedItems", params: { count: num(row, "unboxedItems") }, cls: "badge--pending" }
        : null;
    case "received_items":
      return { kind: "label", labelKey: "viewConfig.chips.receivedItems", params: { count: num(row, "receivedItems") }, cls: "badge--clear" };
    case "package_count":
      return { kind: "label", labelKey: "viewConfig.chips.packageCount", params: { count: num(row, "packageCount") }, cls: "badge--pending" };
    case "verify_verified_count":
      return {
        kind: "label",
        labelKey: "common.packagesVerified",
        params: { verified: num(row, "verifyVerifiedCount"), total: num(row, "packageCount") },
        cls: "badge--pending",
      };
    case "verified_count":
      return {
        kind: "label",
        labelKey: "common.packagesVerified",
        params: { verified: num(row, "verifiedCount"), total: num(row, "packageCount") },
        cls: "badge--pending",
      };
    default:
      return null;
  }
}

// ------------------------------------------------------------------
// Detail-page field rendering
// ------------------------------------------------------------------

const NO_DATA = "—";

function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return NO_DATA;
  return String(value);
}

interface ReceivingItemLike {
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  lineQty: number | null;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  allocatedQty: number;
  ctnNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

/** Value of one receivingDetail field for a receiving item. */
export function receivingItemFieldValue(field: string, item: ReceivingItemLike): string {
  switch (field) {
    case "wcl_item_no": return text(item.wclItemNo ?? item.partNo);
    case "part_no": return text(item.partNo);
    case "expected_qty": return String(item.lineQty ?? NO_DATA);
    case "received_qty": return String(item.receivedQty);
    case "po_no": return text(item.poNo);
    case "po_line": return text(item.poLine);
    case "box_id": return text(item.ctnNo);
    case "date_code": return text(item.dateCode);
    case "lot_code": return text(item.lotCode);
    case "coo": return text(item.coo);
    case "cow": return text(item.cow);
    case "reserved_qty": return String(item.allocatedQty);
    case "picked_qty": return String(item.pickedQty);
    case "put_away_qty": return String(item.putAwayQty);
    case "available_qty": return String(item.receivedQty - item.pickedQty - item.putAwayQty - item.allocatedQty);
    default: return NO_DATA;
  }
}

interface PutAwayItemLike {
  partNo: string;
  wclItemNo: string | null;
  lineQty: number | null;
  receivedQty: number;
  remainingQty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  suggestedShelfCode?: string | null;
  suggestedBoxId?: string | null;
}

/** Value of one putAwayDetail field for a put-away expected item. */
export function putAwayItemFieldValue(field: string, item: PutAwayItemLike): string {
  switch (field) {
    case "wcl_item_no": return text(item.wclItemNo ?? item.partNo);
    case "part_no": return text(item.partNo);
    case "expected_qty": return String(item.lineQty ?? NO_DATA);
    case "received_qty": return String(item.receivedQty);
    case "remaining_qty": return String(item.remainingQty);
    case "po_no": return NO_DATA; // not carried on the put-away item DTO
    case "box_id": return NO_DATA;
    case "date_code": return text(item.dateCode);
    case "lot_code": return text(item.lotCode);
    case "coo": return text(item.coo);
    case "cow": return text(item.cow);
    case "suggested_shelf":
      return item.suggestedShelfCode
        ? item.suggestedBoxId
          ? `${item.suggestedShelfCode} / ${item.suggestedBoxId}`
          : item.suggestedShelfCode
        : NO_DATA;
    default: return NO_DATA;
  }
}

/** Detail fields that identify the row (rendered as the title, not a field). */
export const IDENTITY_DETAIL_FIELDS = new Set(["wcl_item_no", "part_no"]);

/** Fields a picking item GROUP can render collapsed (lot-level fields only
 *  make sense inside the expanded allocation rows). */
export const PICKING_GROUP_FIELDS = new Set(["wcl_item_no", "part_no", "qty", "picked_qty", "allocated_qty", "status"]);
