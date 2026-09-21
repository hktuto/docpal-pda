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
  supplier_code: "supplierCode",
  supplier_name: "supplierName",
  delivery_date: "deliveryDate",
  date_code: "dateCode",
};

export function formatReceivingOrderName(fields: ReceivingOrderNameFields, template: string): string {
  const rendered = template.replace(/\[([^\]]*)\]/g, (whole, name: string) => {
    const key = PLACEHOLDERS[name];
    if (!key) return whole;
    return fields[key] ?? "";
  });
  return rendered.trim() === "" ? (fields.batchNo ?? "") : rendered;
}
