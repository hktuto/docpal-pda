export interface EntityField {
  key: string;
  /** i18n key (under admin.fields.*) resolved by CrudTable/CrudForm via $t. */
  label: string;
  type: "text" | "number" | "password" | "multiSelect" | "subInventoryPicker" | "json" | "boolean" | "select" | "conditions";
  /**
   * multiSelect only: where the option list comes from.
   * "customerAccounts" = party names from GET /admin/customer-accounts.
   * The payload is a string array (null when nothing is selected).
   * ("subInventoryPicker" fields always use the org-grouped sub-inventory
   * scope picker — payload [{ orgId, code }] pairs, null when empty — and
   * need no optionsSource.)
   */
  optionsSource?: "customerAccounts";
  /**
   * select only: static option list (single-select). `label` may be a plain
   * string or an i18n key (resolved with $t when it starts with "admin.").
   */
  options?: { value: string; label: string }[];
  /** Create-mode initial value (currently used by boolean fields). */
  defaultValue?: unknown;
  /** Optional i18n key for explanatory text shown above the field input. */
  hint?: string;
  /** Optional table-cell formatter (overrides the default formatCell). */
  format?: (value: unknown) => string;
  required?: boolean;
  /** Disabled in the edit form (used for primary keys, which are immutable). */
  readonlyOnEdit?: boolean;
  /**
   * Write-only field (e.g. password): empty input omits the key from the
   * payload instead of sending null. On edit this also relaxes `required`,
   * so leaving it blank keeps the current server-side value.
   */
  omitWhenEmpty?: boolean;
}

export interface EntityConfig {
  /** API path segment under /admin/. */
  path: string;
  /** i18n key (under admin.entities.*) resolved by CrudTable via $t. */
  title: string;
  /** Primary-key column name, used in /:id URLs. */
  pk: string;
  fields: EntityField[];
  /** Extra read-only columns shown in the table but never in the form. Labels are i18n keys. */
  extraColumns?: { key: string; label: string; sortable?: boolean }[];
  /**
   * Fallback row id when the API row has no `pk` column (composite-key
   * tables). The derived value is used for row keys and /:id URLs.
   */
  deriveId?: (row: any) => string;
  /** Hide the Edit action (create/delete-only resources). */
  noEdit?: boolean;
  /**
   * Show a leading checkbox column and a `bulk-actions` slot (above the table,
   * receives `{ rows, clear }`) for multi-row actions like label printing.
   */
  selectable?: boolean;
  /**
   * Large tables (e.g. the ~100k-row parts master): fetch pages from the
   * server (?page=&pageSize=&q= → { rows, total }) instead of paging the
   * full list client-side. Shows a search box.
   */
  serverPaging?: boolean;
  /**
   * Client mode only: show the search box and filter rows client-side
   * (case-insensitive substring across all rendered columns) before paging.
   */
  clientSearch?: boolean;
  /**
   * Client mode only: dropdown filters rendered next to the search box;
   * options are the distinct values of `key` across the loaded rows, matched
   * exactly. `label` is an i18n key.
   */
  clientFilters?: { key: string; label: string }[];
  /** Clickable sort headers (default true). Set false to opt the entity out. */
  sortable?: boolean;
  /**
   * Server mode only: extra text filters rendered next to the search box;
   * non-empty values are sent as query params (debounced, resets to page 1).
   * `label` is an i18n key.
   */
  filterFields?: { param: string; label: string }[];
}

/** Table-cell rendering for [{ orgId, code }] scope pairs: "2 / STORE1, …". */
function formatScopes(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "—";
  return value
    .map((s) => (s && typeof s === "object" ? `${(s as any).orgId} / ${(s as any).code}` : String(s)))
    .join(", ");
}

/** Compact summary of a label-print-rule conditions object, e.g. "org_id = 2 AND customer ~ C00*". */
function formatConditions(value: unknown): string {
  const c = value as { combinator?: string; conditions?: { field: string; operator: string; value: string }[] } | null;
  if (!c || !Array.isArray(c.conditions) || c.conditions.length === 0) return "—";
  const joiner = c.combinator === "or" ? " OR " : " AND ";
  return c.conditions.map((x) => `${x.field} ${x.operator === "match" ? "~" : "="} ${x.value}`).join(joiner);
}

/** Active flag as a check/cross marker. */
function formatActive(value: unknown): string {
  return value ? "✔" : "✘";
}

export const entities: Record<string, EntityConfig> = {
  shelves: {
    path: "shelves",
    title: "admin.entities.shelves.title",
    pk: "code",
    selectable: true,
    clientSearch: true,
    clientFilters: [{ key: "zone", label: "admin.fields.zone" }],
    fields: [
      { key: "code", label: "admin.fields.code", type: "text", required: true, readonlyOnEdit: true },
      { key: "zone", label: "admin.fields.zone", type: "text" },
      // Advisory operator warning shown on allocations pointing at this shelf
      // (empty = none). Spec 2026-09-17-shelf-warning-design.md.
      { key: "warning", label: "admin.fields.shelfWarning", type: "text" },
      // Advisory sub-inventory affinity for put-away shelf suggestions,
      // org-scoped [{ orgId, code }] pairs (empty = shared).
      {
        key: "subInventoryScopes",
        label: "admin.fields.subInventoryCodes",
        type: "subInventoryPicker",
        hint: "admin.fields.subInventoryCodesHint",
        format: formatScopes,
      },
    ],
    extraColumns: [
      { key: "createdDate", label: "admin.fields.createdDate" },
      { key: "lastUpdateDate", label: "admin.fields.lastUpdateDate" },
    ],
  },
  customerProfiles: {
    path: "customer-profiles",
    title: "admin.entities.customerProfiles.title",
    pk: "code",
    clientSearch: true,
    fields: [
      { key: "code", label: "admin.fields.code", type: "text", required: true, readonlyOnEdit: true },
      { key: "label", label: "admin.fields.label", type: "text", required: true },
      { key: "rule", label: "admin.fields.rule", type: "json" },
      { key: "remark", label: "admin.fields.remark", type: "text" },
      { key: "customers", label: "admin.fields.customers", type: "multiSelect", optionsSource: "customerAccounts" },
    ],
    extraColumns: [
      { key: "createdDate", label: "admin.fields.createdDate" },
      { key: "lastUpdateDate", label: "admin.fields.lastUpdateDate" },
    ],
  },
  suppliers: {
    path: "suppliers",
    title: "admin.entities.suppliers.title",
    pk: "id",
    clientSearch: true,
    fields: [
      { key: "code", label: "admin.fields.code", type: "text", required: true },
      { key: "name", label: "admin.fields.name", type: "text", required: true },
      { key: "shortName", label: "admin.fields.shortName", type: "text" },
    ],
  },
  parts: {
    path: "parts",
    title: "admin.entities.parts.title",
    pk: "id",
    serverPaging: true,
    filterFields: [{ param: "brand", label: "admin.fields.brand" }],
    fields: [
      { key: "brand", label: "admin.fields.brand", type: "text", required: true },
      { key: "partNo", label: "admin.fields.partNo", type: "text", required: true },
      { key: "wclItemNo", label: "admin.fields.wclItemNo", type: "text" },
      { key: "description", label: "admin.fields.description", type: "text" },
    ],
  },
  countries: {
    path: "countries",
    title: "admin.entities.countries.title",
    pk: "code",
    fields: [
      { key: "code", label: "admin.fields.code", type: "text", required: true, readonlyOnEdit: true },
      { key: "name", label: "admin.fields.name", type: "text", required: true },
    ],
  },
  "box-sizes": {
    path: "box-sizes",
    title: "admin.entities.boxSizes.title",
    pk: "code",
    fields: [
      { key: "code", label: "admin.fields.code", type: "text", required: true, readonlyOnEdit: true },
      { key: "description", label: "admin.fields.description", type: "text" },
    ],
  },
  "net-weight-formulas": {
    path: "net-weight-formulas",
    title: "admin.entities.netWeightFormulas.title",
    pk: "id",
    serverPaging: true,
    fields: [
      { key: "partNo", label: "admin.fields.partNo", type: "text", required: true },
      { key: "qty", label: "admin.fields.qtyPcs", type: "number", required: true },
      { key: "weight", label: "admin.fields.weightGrams", type: "number", required: true },
    ],
  },
  labelPrintRules: {
    path: "label-print-rules",
    title: "admin.entities.labelPrintRules.title",
    pk: "id",
    noEdit: true,
    clientSearch: true,
    fields: [
      { key: "name", label: "admin.fields.name", type: "text", required: true },
      {
        key: "labelType",
        label: "admin.fields.labelType",
        type: "select",
        required: true,
        options: [
          { value: "carton", label: "admin.pages.labelPrintRules.labelTypes.carton" },
          { value: "item_box", label: "admin.pages.labelPrintRules.labelTypes.item_box" },
          { value: "item", label: "admin.pages.labelPrintRules.labelTypes.item" },
        ],
      },
      {
        key: "conditions",
        label: "admin.fields.conditions",
        type: "conditions",
        required: true,
        format: formatConditions,
      },
      {
        key: "printTemplateId",
        label: "admin.fields.printTemplateId",
        type: "text",
        required: true,
        hint: "admin.fields.printTemplateIdHint",
      },
      { key: "priority", label: "admin.fields.priority", type: "number" },
      { key: "active", label: "admin.fields.active", type: "boolean", format: formatActive, defaultValue: true },
      { key: "remark", label: "admin.fields.remark", type: "text" },
    ],
    extraColumns: [
      { key: "createdDate", label: "admin.fields.createdDate" },
      { key: "lastUpdateDate", label: "admin.fields.lastUpdateDate" },
    ],
  },
};

/** Top-nav grouping per the admin TOC (apps/admin/TOC.md).
 *  `title` values are i18n keys resolved by app.vue via `$t`. */
export const navSections: { title: string; links: { route: string; title: string }[] }[] = [
  {
    title: "admin.nav.customer",
    links: [
      { route: "/customer-profiles", title: "admin.navLinks.customerProfiles" },
      { route: "/customer-profile-list", title: "admin.navLinks.customerProfileList" },
    ],
  },
  {
    title: "admin.nav.supplier",
    links: [{ route: "/suppliers", title: "admin.navLinks.suppliers" }],
  },
  {
    title: "admin.nav.warehouse",
    links: [
      { route: "/shelves", title: "admin.navLinks.shelves" },
      { route: "/shelf-boxes", title: "admin.navLinks.shelfBoxes" },
      { route: "/sub-inventories", title: "admin.navLinks.subInventories" },
      { route: "/parts", title: "admin.navLinks.parts" },
      { route: "/stock-search", title: "admin.navLinks.stockSearch" },
    ],
  },
  {
    title: "admin.nav.picking",
    links: [
      { route: "/picking-orders", title: "admin.navLinks.pickingOrders" },
      { route: "/picking/reorder", title: "admin.navLinks.reorder" },
    ],
  },
  {
    title: "admin.nav.receiving",
    links: [{ route: "/receiving", title: "admin.navLinks.receivingOrders" }],
  },
  {
    title: "admin.nav.issues",
    links: [
      { route: "/issues/receiving", title: "admin.navLinks.receivingIssues" },
      { route: "/issues/picking", title: "admin.navLinks.pickingIssues" },
    ],
  },
  {
    title: "admin.nav.shipping",
    links: [{ route: "/shipping", title: "admin.navLinks.shippingOrders" }],
  },
  {
    title: "admin.nav.settings",
    links: [
      { route: "/flow-config", title: "admin.navLinks.flowConfig" },
      { route: "/display-config", title: "admin.navLinks.displayConfig" },
      { route: "/app-download", title: "admin.navLinks.appDownload" },
      { route: "/user-badges", title: "admin.navLinks.userBadges" },
      { route: "/user-profiles", title: "admin.navLinks.userProfiles" },
    ],
  },
  {
    title: "admin.nav.dropdownPolicy",
    links: [
      { route: "/net-weight-formulas", title: "admin.navLinks.netWeight" },
      { route: "/box-sizes", title: "admin.navLinks.boxSizes" },
      { route: "/countries", title: "admin.navLinks.countries" },
      { route: "/label-print-rules", title: "admin.navLinks.labelPrintRules" },
    ],
  },
];
