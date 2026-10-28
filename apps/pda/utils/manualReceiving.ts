// Manual receiving (手動收貨) draft helpers — the task (order numbers +
// scanned items) is staged locally on the PDA and committed in one
// createCnManualReceipt call (spec 2026-10-27-manual-receiving-pda-design).

export interface ManualReceivingDraftItem {
  uid: number;
  partNo: string;
  /** WCL item number from the matched label template — display + backend echo. */
  wclItemNo?: string;
  /** Brand from the matched supplier template — the whole task shares one brand. */
  brand?: string;
  qty: number;
  dateCode: string;
  lotCode: string;
  coo: string;
  cow: string;
  supplierCode?: string;
  /** The scanned label text — duplicate-scan guard + server traceability. */
  raw?: string;
}

export interface ManualReceivingDraftOrder {
  orderNo: string;
  items: ManualReceivingDraftItem[];
}

/** Duplicate comparison key for order numbers: trimmed, uppercase, whitespace
 *  collapsed out (mirrors the backend validator). */
export function normalizeOrderNo(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function isDuplicateOrderNo(orders: ManualReceivingDraftOrder[], orderNo: string, ignoreIndex = -1): boolean {
  const key = normalizeOrderNo(orderNo);
  if (!key) return false;
  return orders.some((o, i) => i !== ignoreIndex && normalizeOrderNo(o.orderNo) === key);
}

export function orderTotalQty(order: ManualReceivingDraftOrder): number {
  return order.items.reduce((sum, item) => sum + item.qty, 0);
}

/** The scanned label is a repeat of an item already in the order. */
export function isDuplicateRaw(order: ManualReceivingDraftOrder, raw: string): boolean {
  return order.items.some((item) => item.raw === raw);
}
