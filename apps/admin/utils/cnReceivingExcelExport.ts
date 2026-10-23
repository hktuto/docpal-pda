import type { CnOrderDetail, CnOrderItemRow } from "~/utils/flowApi";

/**
 * Rebuilds the 收貨確認及付款通知書 fixed form (the CN receiving Excel —
 * supporting_doc/cn_receiving/TE20261010-2.xls) from a synced CN order so it
 * can be re-downloaded as .xlsx from the admin detail page.
 *
 * Pure: returns an AOA plus merge ranges; the caller does the XLSX.write
 * (aoa_to_sheet / book_append_sheet / writeFile).
 */

/** Merge range shape XLSX expects on ws["!merges"]. */
export interface CnExportMerge {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface CnExportAoa {
  aoa: (string | number)[][];
  merges: CnExportMerge[];
}

function jsonbString(obj: Record<string, unknown> | null | undefined, key: string): string {
  const v = obj?.[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : "";
}

/** First non-empty value across the items' jsonb passthroughs (order-level
 *  extras arrive duplicated on each item). */
function firstJsonb(items: CnOrderItemRow[], key: string): string {
  for (const it of items) {
    const v = jsonbString(it.orderData, key) || jsonbString(it.additionalData, key);
    if (v) return v;
  }
  return "";
}

function numeric(value: string | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Digit-run-aware compare ("9" < "10"); empty sorts first. */
function compareNumericAware(a: string, b: string): number {
  const ra = a.match(/(\d+|\D+)/g) ?? [];
  const rb = b.match(/(\d+|\D+)/g) ?? [];
  const n = Math.max(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const x = ra[i];
    const y = rb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const cmp = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y, undefined, { sensitivity: "base" });
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Item table column mapping, 訂單號 → 備註. CENTRALIZED here — the wire
 * contract swaps orderNo/poNo relative to the paper form (訂單號 carries the
 * PO number, 发货项 carries the order no), so adjust after visual
 * verification against a real regenerated file.
 */
export const CN_EXPORT_ITEM_COLUMNS: { header: string; value: (it: CnOrderItemRow) => string | number }[] = [
  { header: "訂單號", value: (it) => it.poNo ?? "" },
  { header: "箱数", value: (it) => it.ctnNo ?? "" },
  { header: "型號", value: (it) => it.partNo },
  { header: "摘要(D/C)", value: (it) => it.dateCode ?? "" },
  { header: "數量(PCS)", value: (it) => it.receivedQty },
  { header: "重量（KG)", value: () => "" },
  { header: "辦事處", value: (it) => it.subInventoryCode ?? "" },
  { header: "发货项", value: (it) => jsonbString(it.orderData, "orderNo") || jsonbString(it.additionalData, "orderNo") },
  { header: "備註", value: () => "" },
  { header: "建議貨架", value: (it) => it.suggestedShelf ?? "" },
];

/** Build the sheet AOA for a CN order detail, mirroring the original form.
 * Item rows are emitted sorted by po_line (the sheet's row index; blanks
 * trail) so a re-imported file preserves the intended order. */
export function buildCnReceivingExportAoa(detail: CnOrderDetail): CnExportAoa {  const items = [...detail.items].sort((a, b) => {
    const al = a.poLine?.trim() ?? "";
    const bl = b.poLine?.trim() ?? "";
    if (!al && !bl) return 0;
    if (!al) return 1;
    if (!bl) return -1;
    return compareNumericAware(al, bl);
  });
  const aoa: (string | number)[][] = [];

  // Title (merged A-E) and the 編號 row, exactly where the parser looks.
  aoa.push(["收貨確認及付款通知書", "", "", "", ""]);
  const refRow: (string | number)[] = Array(9).fill("");
  refRow[7] = "編    號:";
  refRow[8] = detail.order.batchNo;
  aoa.push(refRow);
  aoa.push([]);

  // Label/value header rows. Precedence: the items' jsonb passthrough (when
  // the workflow stored them there), then the matched upload workflow's
  // payload (the _cn tables carry none of these), else blank.
  const wf = detail.workflow;
  aoa.push([
    "收貨辦事處:  ",
    firstJsonb(items, "receivedOffice") || wf?.receivedOffice || "",
    "",
    "",
    "",
    "",
    "收貨日期:",
    detail.order.deliveryDate ?? wf?.receivedDate ?? "",
  ]);
  aoa.push(["供應商:", firstJsonb(items, "supplier") || wf?.supplier || ""]);
  aoa.push(["發票號碼:", firstJsonb(items, "receiptNo") || wf?.receiptNo || ""]);

  aoa.push(CN_EXPORT_ITEM_COLUMNS.map((c) => c.header));
  for (const it of items) {
    aoa.push(CN_EXPORT_ITEM_COLUMNS.map((c) => c.value(it)));
  }

  aoa.push(["合计：", items.reduce((s, it) => s + numeric(it.ctnNo), 0), "", "", items.reduce((s, it) => s + it.receivedQty, 0)]);
  aoa.push(["收貨注意事項:"]);
  aoa.push(["1. 收到以上貨品型號與實物一致嗎?     是_____or否_____(請在備註加以說明)"]);
  aoa.push(["2. 收到以上數量與實數量一致嗎?       是_____or否_____(請在備註加以說明)"]);
  aoa.push(["通知人(簽名):", "", "核對人(簽名):________________", "", "核數人(簽名): ", "", "確認付款通知人(簽名):"]);

  return { aoa, merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }] };
}

/** QR payload for the exported sheet: scanning it on the PDA jumps straight
 *  into this order's put-away task. Null when no task exists yet. */
export function cnPutAwayQrPayload(detail: CnOrderDetail): string | null {
  return detail.putAway ? `/put-away/${detail.order.id}?task=${detail.putAway.id}` : null;
}
