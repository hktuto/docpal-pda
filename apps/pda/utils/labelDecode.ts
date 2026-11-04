import { parseAndIdentify, type OcrParseResult } from '~/utils/parseOcrScan';
import type { WarehouseService } from '~/services/warehouse';

export interface LabelDecodeOptions {
  targets?: string[];
  supplierCode?: string;
  brands?: string[];
}

/**
 * Decode a raw label scan value via the backend decode authority
 * (POST /scan/decode — supplier templates, month-counter periods and NCC
 * drawing-code resolution all require DB lookups; spec
 * docs/superpowers/specs/2026-11-03-backend-scan-decode-design.md).
 *
 * On matched:false the client-side, no-DB OCR heuristics take over — exactly
 * the fallback parseQrCapture ran before the 2026-11-03 cutover. Network
 * errors propagate (the scan is reported like any failed request).
 */
export async function decodeLabel(
  warehouse: WarehouseService,
  rawValue: string,
  options: LabelDecodeOptions = {}
): Promise<OcrParseResult> {
  // [DECODE-TIME] round trip vs the backend's [DECODE-TIME] line: the
  // difference is network + JWT overhead (visible via adb/CDP console).
  const t0 = performance.now();
  const decoded = await warehouse.decodeScan({
    raw: rawValue,
    ...(options.targets && { targets: options.targets }),
    ...(options.supplierCode && { supplierCode: options.supplierCode }),
    ...(options.brands && { brands: options.brands }),
  });
  console.log(
    `[DECODE-TIME] POST /scan/decode ${decoded.matched ? "matched" : "no-match"} ${(performance.now() - t0).toFixed(1)}ms`
  );
  if (decoded.matched) {
    return { ...decoded, raw: { text: rawValue, barcodes: [] } };
  }
  return parseAndIdentify(
    { text: rawValue, barcodes: [{ value: rawValue, format: '4' }] },
    options.targets ?? []
  );
}
