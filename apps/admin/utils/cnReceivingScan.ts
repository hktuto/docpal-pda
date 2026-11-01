// CN receiving scan step — inline trilingual labels. The shared locale files
// live in layers/i18n (outside apps/admin), so the new 'scanning' order status
// and the per-item scan outcome labels are kept here instead of $t keys.

type Locale3 = "en-US" | "zh-CN" | "zh-HK";

function pick(locale: string, map: Record<Locale3, string>): string {
  return map[locale as Locale3] ?? map["en-US"];
}

const SCANNING_LABEL: Record<Locale3, string> = {
  "en-US": "Scanning",
  "zh-CN": "扫描中",
  "zh-HK": "掃描中",
};

/** Order status label — delegates to the locale files for the existing
 *  statuses, renders 'scanning' inline until a locale key exists. */
export function cnOrderStatusLabel(status: string, t: (key: string) => string, locale: string): string {
  if (status === "scanning") return pick(locale, SCANNING_LABEL);
  return t(`status.receiving.${status}`);
}

export const CN_SCAN_STATUSES = ["ok", "warning", "error"] as const;
export type CnScanStatus = (typeof CN_SCAN_STATUSES)[number];

export const CN_SCAN_REASONS = ["qty_mismatch", "missing", "damaged", "wrong_part", "other"] as const;
export type CnScanReason = (typeof CN_SCAN_REASONS)[number];

const SCAN_STATUS_LABELS: Record<CnScanStatus, Record<Locale3, string>> = {
  ok: { "en-US": "OK", "zh-CN": "正常", "zh-HK": "正常" },
  warning: { "en-US": "Qty mismatch", "zh-CN": "数量不符", "zh-HK": "數量不符" },
  error: { "en-US": "Error", "zh-CN": "异常", "zh-HK": "異常" },
};

const SCAN_REASON_LABELS: Record<CnScanReason, Record<Locale3, string>> = {
  qty_mismatch: { "en-US": "Qty mismatch", "zh-CN": "数量不符", "zh-HK": "數量不符" },
  missing: { "en-US": "Missing", "zh-CN": "缺货", "zh-HK": "缺貨" },
  damaged: { "en-US": "Damaged", "zh-CN": "损坏", "zh-HK": "損壞" },
  wrong_part: { "en-US": "Wrong part", "zh-CN": "料号错误", "zh-HK": "料號錯誤" },
  other: { "en-US": "Other", "zh-CN": "其他", "zh-HK": "其他" },
};

export function cnScanStatusLabel(status: string | null, locale: string): string {
  if (!status) return pick(locale, { "en-US": "Unscanned", "zh-CN": "未扫描", "zh-HK": "未掃描" });
  const labels = SCAN_STATUS_LABELS[status as CnScanStatus];
  return labels ? pick(locale, labels) : status;
}

export function cnScanReasonLabel(reason: string | null, locale: string): string {
  if (!reason) return "";
  const labels = SCAN_REASON_LABELS[reason as CnScanReason];
  return labels ? pick(locale, labels) : reason;
}

/** Confirm-dialog copy — the old locale key says the confirm creates the
 *  put-away task, which is no longer true (the order moves to 'scanning' and
 *  the task appears only after the PDA scan finalizes). */
export function cnConfirmOrderConfirm(batchNo: string, locale: string): string {
  return pick(locale, {
    "en-US": `Confirm order ${batchNo}? The order moves to scanning — a PDA operator scans the physical items before put-away.`,
    "zh-CN": `确认订单 ${batchNo}？订单将进入扫描状态 — 需由 PDA 扫描实物后才会上架。`,
    "zh-HK": `確認訂單 ${batchNo}？訂單會進入掃描狀態 — 需由 PDA 掃描實物後才會上架。`,
  });
}

/** Success notice shown after the admin confirms. */
export function cnConfirmOrderDone(locale: string): string {
  return pick(locale, {
    "en-US": "Order confirmed — awaiting PDA receiving scan.",
    "zh-CN": "订单已确认 — 等待 PDA 收货扫描。",
    "zh-HK": "訂單已確認 — 等待 PDA 收貨掃描。",
  });
}

/** Column header for the per-item scan outcome column. */
export function cnScanColumnLabel(locale: string): string {
  return pick(locale, { "en-US": "Scan", "zh-CN": "扫描", "zh-HK": "掃描" });
}
