// Receiving order name display template (spec
// docs/superpowers/specs/2026-09-21-receiving-order-name-template-design.md):
// client-side mirror of the backend formatter (apps/backend/src/receivingOrderName.ts)
// for the admin display-config live preview. The PDA/admin screens render the
// backend-computed `displayName`; this copy only previews the template.

export interface ReceivingOrderNameFields {
  batchNo?: string | null;
  invoiceNo?: string | null;
  supplierCode?: string | null;
  supplierName?: string | null;
  deliveryDate?: string | null;
  dateCode?: string | null;
}

const PLACEHOLDERS: Record<string, keyof ReceivingOrderNameFields> = {
  batch_no: "batchNo",
  invoice_no: "invoiceNo",
  invoice_no_first: "invoiceNo",
  supplier_code: "supplierCode",
  supplier_name: "supplierName",
  delivery_date: "deliveryDate",
  date_code: "dateCode",
};

/** Tokens rendering only the first value of a comma-joined field. */
const FIRST_ONLY = new Set(["invoice_no_first"]);

export function formatReceivingOrderName(fields: ReceivingOrderNameFields, template: string): string {
  const rendered = template.replace(/\[([^\]]*)\]/g, (whole, name: string) => {
    const key = PLACEHOLDERS[name];
    if (!key) return whole;
    const value = fields[key] ?? "";
    return FIRST_ONLY.has(name) ? value.split(", ")[0] : value;
  });
  return rendered.trim() === "" ? (fields.batchNo ?? "") : rendered;
}
