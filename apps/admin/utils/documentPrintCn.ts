/**
 * CN receiving confirmation (收貨確認及付款通知書) → PrintDocument.
 *
 * Mirrors buildCnReceivingExportAoa (utils/cnReceivingExcelExport.ts) field
 * for field — same CN_EXPORT_ITEM_COLUMNS headers/values, same po_line
 * numeric-aware item sort, same jsonb-first header fallback, same 合计
 * totals and notice/signature lines — so the printed form and the .xlsx
 * download cannot drift apart. The vitest asserts the header list matches
 * CN_EXPORT_ITEM_COLUMNS exactly.
 */
import type { CnOrderDetail } from "~/utils/flowApi";
import type { PrintDocument } from "~/utils/documentPrint";
import {
  CN_EXPORT_ITEM_COLUMNS,
  cnPutAwayQrPayload,
  firstJsonb,
  sortCnItemsByPoLine,
} from "~/utils/cnReceivingExcelExport";

function numeric(value: string | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Column weights (sum 1) for the 10 CN_EXPORT_ITEM_COLUMNS: 型號/partNo and
// 訂單號 carry the longest values and get the most room; the 箱数/數量
// numeric columns stay narrow.
const CN_COLUMN_WEIGHTS = [0.16, 0.06, 0.18, 0.09, 0.08, 0.08, 0.08, 0.12, 0.07, 0.08];
const CN_RIGHT_ALIGNED = new Set(["箱数", "數量(PCS)"]);

/** Fixed notice/signature block, identical to the Excel export's last rows
 *  (the signature row is one line here — canvas has no cells to span). */
const CN_FOOT_LINES = [
  "收貨注意事項:",
  "1. 收到以上貨品型號與實物一致嗎?     是_____or否_____(請在備註加以說明)",
  "2. 收到以上數量與實數量一致嗎?       是_____or否_____(請在備註加以說明)",
  "通知人(簽名):____________    核對人(簽名):________________    核數人(簽名):____________    確認付款通知人(簽名):____________",
];

export function buildCnReceivingPrintDoc(detail: CnOrderDetail): PrintDocument {
  const items = sortCnItemsByPoLine(detail.items);
  const wf = detail.workflow;
  const qrPayload = cnPutAwayQrPayload(detail);
  return {
    title: "收貨確認及付款通知書",
    ref: detail.order.batchNo,
    head: [
      ["收貨辦事處:", firstJsonb(items, "receivedOffice") || wf?.receivedOffice || ""],
      ["收貨日期:", detail.order.deliveryDate ?? wf?.receivedDate ?? ""],
      ["供應商:", firstJsonb(items, "supplier") || wf?.supplier || ""],
      ["發票號碼:", firstJsonb(items, "receiptNo") || wf?.receiptNo || ""],
    ],
    table: {
      columns: CN_EXPORT_ITEM_COLUMNS.map((c, i) => ({
        header: c.header,
        weight: CN_COLUMN_WEIGHTS[i],
        align: CN_RIGHT_ALIGNED.has(c.header) ? ("right" as const) : ("left" as const),
      })),
      rows: items.map((it) => CN_EXPORT_ITEM_COLUMNS.map((c) => c.value(it))),
      totals: [
        "合计：",
        items.reduce((s, it) => s + numeric(it.ctnNo), 0),
        "",
        "",
        items.reduce((s, it) => s + it.receivedQty, 0),
        "",
        "",
        "",
        "",
        "",
      ],
    },
    foot: CN_FOOT_LINES,
    qr: qrPayload ? { payload: qrPayload } : null,
    orientation: "landscape",
  };
}
