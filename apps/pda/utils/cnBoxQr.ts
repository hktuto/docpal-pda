// Carton QR on CN (HK-style) receiving boxes — parser + box targeting.
// Spec: docs/superpowers/specs/2026-11-18-cn-putaway-box-qr-design.md
//
// Payload (verified on real prints):
//   0;SZ-26110077;1;2;6;KOA+RK73H1ETTP 1000F;24;18;2F;…;Made In China;
//     │      │       │  │  └ item count in this box — ignored, the DB is
//     │      │       │  │    authoritative (putAway.cn dialog reads the
//     │      │       │  │    invoice items, never this tail)
//     │      │       │  └ total boxes (display only)
//     │      │       └ box seq (1-based index into the invoice's distinct
//     │      │         ctn_no values sorted NUMERICALLY)
//     │      └ invoice no = receiving_invoices_cn.invoice_no
//     └ constant, ignored
//
// Chrome 101: string math only, no newer Web APIs.

export interface CnBoxQr {
  invoiceNo: string;
  boxSeq: number;
  totalBoxes: number;
}

export type CnBoxResolveError = "wrong_order" | "no_numeric_ctn" | "not_found";

export interface CnBoxTarget<Line extends CnBoxLine> {
  ctnNo: string;
  lines: Line[];
}

/** Minimal shape the resolver needs from a put-away item row. */
export interface CnBoxLine {
  ctnNo?: string | null;
  invoiceNo?: string | null;
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Numeric identity of a ctn_no — "038" and "38" are the same box. */
function numericCtn(ctnNo: string | null | undefined): number | null {
  const s = (ctnNo ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * Parse a raw scan into a carton-QR target, or null when the scan is not a
 * carton QR (every caller falls through to the item-label path). Strict on
 * purpose: a false positive here would swallow real part labels.
 */
export function parseCnBoxQr(raw: string): CnBoxQr | null {
  const fields = raw
    .trim()
    .split(";")
    .map((f) => f.trim());
  // The trailing ";" after "Made In China" leaves an empty final field.
  while (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  if (fields.length < 6) return null;
  const [flag, invoiceNo, boxSeqRaw, totalBoxesRaw, itemCountRaw] = fields;
  // Field 1 is a constant "0" on current prints; any integer is accepted so
  // a future version bump does not silently break targeting.
  if (!/^\d+$/.test(flag)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(invoiceNo)) return null;
  const boxSeq = parsePositiveInt(boxSeqRaw);
  const totalBoxes = parsePositiveInt(totalBoxesRaw);
  const itemCount = parsePositiveInt(itemCountRaw);
  if (boxSeq === null || totalBoxes === null || itemCount === null) return null;
  if (boxSeq > totalBoxes) return null;
  return { invoiceNo, boxSeq, totalBoxes };
}

/**
 * Resolve a parsed QR to a concrete box: the invoice's items' distinct
 * numeric ctn_no values, sorted numerically (ctn_no is text — "10" must not
 * sort before "2"), 1-based index = boxSeq. Lines include fully-put-away
 * rows so a box keeps resolving the same way after partial put-away.
 */
export function resolveCnBox<Line extends CnBoxLine>(
  qr: CnBoxQr,
  items: readonly Line[],
): CnBoxTarget<Line> | { error: CnBoxResolveError } {
  const invoiceItems = items.filter((it) => (it.invoiceNo ?? null) === qr.invoiceNo);
  if (invoiceItems.length === 0) return { error: "wrong_order" };
  const ctnNos = new Set<number>();
  for (const it of invoiceItems) {
    const n = numericCtn(it.ctnNo);
    if (n !== null) ctnNos.add(n);
  }
  if (ctnNos.size === 0) return { error: "no_numeric_ctn" };
  const sorted = [...ctnNos].sort((a, b) => a - b);
  const target = sorted[qr.boxSeq - 1];
  if (target === undefined) return { error: "not_found" };
  return {
    ctnNo: String(target),
    lines: invoiceItems.filter((it) => numericCtn(it.ctnNo) === target),
  };
}
