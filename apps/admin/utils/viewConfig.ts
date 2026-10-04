// PDA view config (flow-config key pdaViewConfig; spec
// docs/superpowers/specs/2026-10-04-pda-app-rewrite-design.md): mirror copy of
// apps/pda/utils/viewConfig.ts for the display-config editor — keep the two
// files in sync. Must match the backend defaults/catalogs in
// apps/backend/src/config.ts.

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

export const PDA_DETAIL_PAGE_KEYS: PdaDetailPageKey[] = ["receivingDetail", "pickingDetail", "putAwayDetail"];

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
    itemFields: ["wcl_item_no", "expected_qty", "remaining_qty"],
    expandedFields: ["received_qty", "po_no", "box_id", "date_code", "lot_code", "coo", "cow", "suggested_shelf"],
  },
};

export function defaultPdaViewConfig(): PdaViewConfig {
  return JSON.parse(JSON.stringify(DEFAULT_PDA_VIEW_CONFIG)) as PdaViewConfig;
}

/** Stored-shape overrides (as read from / written to the flow-config row). */
export interface PdaViewConfigOverrides {
  lists?: Partial<Record<PdaViewListKey, Partial<PdaListViewConfig>>>;
  receivingDetail?: Partial<PdaReceivingDetailViewConfig>;
  pickingDetail?: Partial<PdaDetailViewConfig>;
  putAwayDetail?: Partial<PdaDetailViewConfig>;
}

/** Merge stored pdaViewConfig overrides over the defaults (with the legacy
 *  pdaListTemplates migration fallback per list, mirroring the backend
 *  pdaViewConfig() accessor). */
export function resolvePdaViewConfig(
  overrides: PdaViewConfigOverrides | undefined,
  legacyListTemplates?: Record<string, { title?: string; meta?: string }>
): PdaViewConfig {
  const resolved = defaultPdaViewConfig();
  for (const key of PDA_VIEW_LIST_KEYS) {
    const listOverride = overrides?.lists?.[key];
    if (listOverride) {
      if (typeof listOverride.title === "string" && listOverride.title.trim()) resolved.lists[key].title = listOverride.title;
      if (Array.isArray(listOverride.meta) && listOverride.meta.length > 0) resolved.lists[key].meta = listOverride.meta;
      if (typeof listOverride.chip === "string" && listOverride.chip.trim()) resolved.lists[key].chip = listOverride.chip;
      continue;
    }
    if (key === "stock-search") continue;
    const legacy = legacyListTemplates?.[key];
    if (legacy?.title?.trim()) resolved.lists[key].title = legacy.title;
    if (legacy?.meta?.trim()) resolved.lists[key].meta = [legacy.meta];
  }
  for (const page of PDA_DETAIL_PAGE_KEYS) {
    const section = overrides?.[page];
    if (!section) continue;
    if (page === "receivingDetail") {
      const g = (section as Partial<PdaReceivingDetailViewConfig>).defaultGrouping;
      if (g && PDA_DETAIL_GROUPINGS.includes(g)) resolved.receivingDetail.defaultGrouping = g;
    }
    if (Array.isArray(section.itemFields) && section.itemFields.length > 0) resolved[page].itemFields = section.itemFields;
    if (Array.isArray(section.expandedFields) && section.expandedFields.length > 0) resolved[page].expandedFields = section.expandedFields;
  }
  return resolved;
}

/** Diff a resolved draft against the defaults → the minimal overrides object
 *  to store (only lists/sections differing from the built-in defaults). */
export function pdaViewConfigOverrides(draft: PdaViewConfig): PdaViewConfigOverrides {
  const out: PdaViewConfigOverrides = {};
  const lists: NonNullable<PdaViewConfigOverrides["lists"]> = {};
  for (const key of PDA_VIEW_LIST_KEYS) {
    const cur = draft.lists[key];
    const def = DEFAULT_PDA_VIEW_CONFIG.lists[key];
    if (cur.title !== def.title || cur.chip !== def.chip || cur.meta.join("\n") !== def.meta.join("\n")) {
      lists[key] = { title: cur.title, meta: cur.meta, chip: cur.chip };
    }
  }
  if (Object.keys(lists).length > 0) out.lists = lists;
  for (const page of PDA_DETAIL_PAGE_KEYS) {
    const cur = draft[page];
    const def = DEFAULT_PDA_VIEW_CONFIG[page];
    const diff: Record<string, unknown> = {};
    if (page === "receivingDetail") {
      const g = (cur as PdaReceivingDetailViewConfig).defaultGrouping;
      if (g !== (def as PdaReceivingDetailViewConfig).defaultGrouping) diff.defaultGrouping = g;
    }
    if (cur.itemFields.join("\n") !== def.itemFields.join("\n")) diff.itemFields = cur.itemFields;
    if (cur.expandedFields.join("\n") !== def.expandedFields.join("\n")) diff.expandedFields = cur.expandedFields;
    if (Object.keys(diff).length > 0) out[page] = diff;
  }
  return out;
}

export interface PdaListRowView {
  title: string;
  meta: string[];
  chip: string;
}

/** Render a list row's title + meta lines through a view config (live
 *  preview in the editor). */
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
