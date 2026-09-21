// Receiving order name display template (spec
// docs/superpowers/specs/2026-09-21-receiving-order-name-template-design.md):
// renders a receiving order's display name through the warehouse-configured
// template, e.g. "[batch_no] · [invoice_no]" → "BATCH-1 · INV-1, INV-2".
// A placeholder whose field is empty renders as "" (no dangling separator);
// unknown [tokens] stay literal. An all-empty render falls back to batch_no so
// a row never displays blank. The backend computes `displayName` on the
// receiving list/detail responses; clients fall back to batchNo themselves.

export interface ReceivingOrderNameFields {
  batchNo?: string | null;
  /** All invoice numbers of the order, comma-joined ("INV-1, INV-2"). */
  invoiceNo?: string | null;
  supplierCode?: string | null;
  supplierName?: string | null;
  /** Date or "YYYY-MM-DD" string. */
  deliveryDate?: Date | string | null;
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

function formatField(key: keyof ReceivingOrderNameFields, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (key === "deliveryDate") {
    // postgres.js hands back a Date for timestamp columns; a date string also
    // arrives here from JSON round-trips. Render YYYY-MM-DD either way.
    const iso = value instanceof Date ? value.toISOString() : String(value);
    return iso.slice(0, 10);
  }
  return String(value);
}

export function formatReceivingOrderName(fields: ReceivingOrderNameFields, template: string): string {
  const rendered = template.replace(/\[([^\]]*)\]/g, (whole, name: string) => {
    const key = PLACEHOLDERS[name];
    if (!key) return whole;
    return formatField(key, fields[key]);
  });
  return rendered.trim() === "" ? (fields.batchNo ?? "") : rendered;
}
