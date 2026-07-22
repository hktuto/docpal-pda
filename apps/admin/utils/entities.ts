export interface EntityField {
  key: string;
  label: string;
  type: "text" | "number" | "password";
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
  title: string;
  /** Primary-key column name, used in /:id URLs. */
  pk: string;
  fields: EntityField[];
  /** Extra read-only columns shown in the table but never in the form. */
  extraColumns?: { key: string; label: string }[];
  /**
   * Fallback row id when the API row has no `pk` column (composite-key
   * tables). The derived value is used for row keys and /:id URLs.
   */
  deriveId?: (row: any) => string;
  /** Hide the Edit action (create/delete-only resources). */
  noEdit?: boolean;
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
    ],
    extraColumns: [
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
      { key: "qrType", label: "QR type", type: "text" },
      { key: "qtyEncoding", label: "Qty encoding", type: "text" },
      { key: "remark", label: "Remark", type: "text" },
    ],
  },
  parts: {
    path: "parts",
    title: "Parts",
    pk: "id",
    fields: [
      { key: "supplierCode", label: "Supplier code", type: "text", required: true },
      { key: "partNo", label: "Part no", type: "text", required: true },
      { key: "wclItemNo", label: "WCL item no", type: "text" },
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
  "customer-profiles": {
    path: "customer-profiles",
    title: "Customer profiles",
    pk: "code",
    fields: [
      { key: "code", label: "Code", type: "text", required: true, readonlyOnEdit: true },
      { key: "label", label: "Label", type: "text", required: true },
      { key: "rule", label: "Rule", type: "text" },
      { key: "remark", label: "Remark", type: "text" },
    ],
  },
  "net-weight-formulas": {
    path: "net-weight-formulas",
    title: "Net-weight formulas",
    pk: "id",
    fields: [
      { key: "partNo", label: "Part no", type: "text", required: true },
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
      // Write-only: required on create, blank on edit keeps the current password.
      { key: "password", label: "Password", type: "password", required: true, omitWhenEmpty: true },
      { key: "displayName", label: "Display name", type: "text", required: true },
    ],
  },
  "user-groups": {
    path: "user-groups",
    title: "User groups",
    pk: "code",
    fields: [
      { key: "code", label: "Code", type: "text", required: true, readonlyOnEdit: true },
      { key: "label", label: "Label", type: "text", required: true },
      { key: "remark", label: "Remark", type: "text" },
    ],
  },
  "user-group-members": {
    path: "user-group-members",
    title: "User group members",
    // Composite-key table: rows may carry no `id`, so fall back to userId:groupCode.
    pk: "id",
    deriveId: (row: any) => `${row.userId}:${row.groupCode}`,
    noEdit: true,
    fields: [
      { key: "userId", label: "User ID", type: "text", required: true },
      { key: "groupCode", label: "Group code", type: "text", required: true },
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
  { key: "customer-profiles", route: "/customer-profiles", title: entities["customer-profiles"].title },
  { key: "net-weight-formulas", route: "/net-weight-formulas", title: entities["net-weight-formulas"].title },
  { key: "users", route: "/users", title: entities.users.title },
  { key: "user-groups", route: "/user-groups", title: entities["user-groups"].title },
  { key: "user-group-members", route: "/user-group-members", title: entities["user-group-members"].title },
];
