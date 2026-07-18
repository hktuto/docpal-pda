export interface EntityField {
  key: string;
  label: string;
  type: "text" | "number";
  required?: boolean;
  /** Disabled in the edit form (used for primary keys, which are immutable). */
  readonlyOnEdit?: boolean;
}

export interface EntityConfig {
  /** API path segment under /admin/. */
  path: string;
  title: string;
  /** Primary-key column name, used in /:id URLs. */
  pk: string;
  fields: EntityField[];
  /** Extra read-only columns shown in the table but never in the form. */
  extraColumns?: { key: string; label: string }[];
}

export const entities: Record<string, EntityConfig> = {
  shelves: {
    path: "shelves",
    title: "Shelves",
    pk: "code",
    fields: [
      { key: "code", label: "Code", type: "text", required: true, readonlyOnEdit: true },
      { key: "zone", label: "Zone", type: "text" },
      { key: "orgId", label: "Org ID", type: "number" },
      { key: "warehouseSectionCode", label: "Warehouse section", type: "text" },
      { key: "subInventoryCode", label: "Sub-inventory code", type: "text" },
      { key: "locationType", label: "Location type", type: "text" },
    ],
    extraColumns: [
      { key: "warehouseCode", label: "Warehouse" },
      { key: "createdAt", label: "Created" },
      { key: "updatedAt", label: "Updated" },
    ],
  },
  suppliers: {
    path: "suppliers",
    title: "Suppliers",
    pk: "id",
    fields: [
      { key: "code", label: "Code", type: "text", required: true },
      { key: "name", label: "Name", type: "text", required: true },
      { key: "shortName", label: "Short name", type: "text" },
    ],
  },
  "supplier-profiles": {
    path: "supplier-profiles",
    title: "Supplier profiles",
    pk: "id",
    fields: [
      { key: "supplierCode", label: "Supplier code", type: "text", required: true },
      { key: "name", label: "Name", type: "text" },
      { key: "qrTemplate", label: "QR template", type: "text" },
      { key: "qtyEncoding", label: "Qty encoding", type: "text" },
      { key: "remark", label: "Remark", type: "text" },
    ],
  },
  parts: {
    path: "parts",
    title: "Parts",
    pk: "id",
    fields: [
      { key: "partNo", label: "Part no", type: "text", required: true },
      { key: "wclItemNo", label: "WCL item no", type: "text" },
      { key: "internalCode", label: "Internal code", type: "text" },
      { key: "description", label: "Description", type: "text" },
      { key: "defaultCoo", label: "Default COO", type: "text" },
    ],
  },
  countries: {
    path: "countries",
    title: "Countries",
    pk: "code",
    fields: [
      { key: "code", label: "Code", type: "text", required: true, readonlyOnEdit: true },
      { key: "name", label: "Name", type: "text", required: true },
    ],
  },
  "box-sizes": {
    path: "box-sizes",
    title: "Box sizes",
    pk: "code",
    fields: [
      { key: "code", label: "Code", type: "text", required: true, readonlyOnEdit: true },
      { key: "description", label: "Description", type: "text" },
    ],
  },
  "sub-inventories": {
    path: "sub-inventories",
    title: "Sub-inventories",
    pk: "code",
    fields: [
      { key: "code", label: "Code", type: "text", required: true, readonlyOnEdit: true },
      { key: "name", label: "Name", type: "text", required: true },
      { key: "customerCode", label: "Customer code", type: "text" },
    ],
  },
  "warehouse-sections": {
    path: "warehouse-sections",
    title: "Warehouse sections",
    pk: "code",
    fields: [
      { key: "code", label: "Code", type: "text", required: true, readonlyOnEdit: true },
      { key: "name", label: "Name", type: "text", required: true },
    ],
    extraColumns: [{ key: "warehouseCode", label: "Warehouse" }],
  },
  "customer-profiles": {
    path: "customer-profiles",
    title: "Customer profiles",
    pk: "code",
    fields: [
      { key: "code", label: "Code", type: "text", required: true, readonlyOnEdit: true },
      { key: "label", label: "Label", type: "text", required: true },
      { key: "remark", label: "Remark", type: "text" },
    ],
  },
  "net-weight-formulas": {
    path: "net-weight-formulas",
    title: "Net-weight formulas",
    pk: "id",
    fields: [
      { key: "partId", label: "Part ID", type: "text", required: true },
      { key: "qty", label: "Qty", type: "number", required: true },
      { key: "weight", label: "Weight", type: "number", required: true },
    ],
  },
  users: {
    path: "users",
    title: "Users",
    pk: "id",
    fields: [
      { key: "username", label: "Username", type: "text", required: true },
      { key: "passwordHash", label: "Password hash", type: "text", required: true },
      { key: "displayName", label: "Display name", type: "text", required: true },
      { key: "role", label: "Role", type: "text" },
    ],
  },
};

/** Pages rendered as a generic CrudTable, in nav order. */
export const entityPages: { key: string; route: string; title: string }[] = [
  { key: "shelves", route: "/shelves", title: entities.shelves.title },
  { key: "suppliers", route: "/suppliers", title: entities.suppliers.title },
  { key: "parts", route: "/parts", title: entities.parts.title },
  { key: "countries", route: "/countries", title: entities.countries.title },
  { key: "box-sizes", route: "/box-sizes", title: entities["box-sizes"].title },
  { key: "warehouse-sections", route: "/warehouse-sections", title: entities["warehouse-sections"].title },
  { key: "sub-inventories", route: "/sub-inventories", title: entities["sub-inventories"].title },
  { key: "customer-profiles", route: "/customer-profiles", title: entities["customer-profiles"].title },
  { key: "net-weight-formulas", route: "/net-weight-formulas", title: entities["net-weight-formulas"].title },
  { key: "users", route: "/users", title: entities.users.title },
];
