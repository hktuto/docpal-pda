// Shared cross-package types. DTOs from apps/web/services/types.ts will migrate
// here in a later spec when the frontend `api` adapter is implemented.
//
// Consumed via type-only imports (e.g. `import type { HealthResponse } from
// "@warehouse/shared"`), so this package ships its TypeScript source directly
// and requires no build step for consumers in this iteration.

export interface HealthResponse {
  ok: boolean;
  db: "ok" | "error";
}

export interface ReceivingPutOrder { ref_no: string; delivery_date?: string | null; supplier_code?: string | null; }
export interface ReceivingPutItem {
  line_no: number; part_no: string; description?: string | null; qty: number;
  box_id?: string | null; date_code?: string | null; lot_code?: string | null; coo?: string | null; cow?: string | null;
}
export interface ReceivingPutInvoice { invoice_no: string; supplier_code?: string | null; items: ReceivingPutItem[]; }
export interface ReceivingPutBody { order: ReceivingPutOrder; invoices: ReceivingPutInvoice[]; }
export interface PickingPutOrder { ref_no: string; ship_to?: string | null; destination_country?: string | null; }
export interface PickingPutItem {
  line_id: string; part_no: string; qty: number;
  required_date_code?: string | null; source_shelf_code?: string | null;
}
export interface PickingPutBody { order: PickingPutOrder; items: PickingPutItem[]; }
export interface IngestUpsertResponse { id: string; external_id: string; created: boolean; changed: boolean; }
export interface ConfirmArrivalResponse { id: string; status: "in_hand"; }
export interface ScanResponse { package_ids: string[]; }
export interface ApiErrorBody { error: string; }
export interface UpdateShippingBoxRequest { box_size?: string | null; net_weight_g?: number | string | null; gross_weight_g?: number | string | null; destination_country?: string | null; }
