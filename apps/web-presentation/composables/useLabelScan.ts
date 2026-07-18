import { ref } from 'vue';
import {
  RectangleDetection,
  SCAN_NOT_AVAILABLE_MESSAGE,
  type LabelScanCapture,
} from './useRectangleDetection';
import { runScanMatcher, useScanMatchers, type ScanTaskContext, type ScanMatchResult } from './useScanMatchers';
import { I18nError } from '~/composables/i18nError';
import { useErrorMessage } from '~/composables/errorMessage';
import { useWarehouse } from '~/composables/useWarehouse';
import { parseAndIdentify, parseQrCapture, type CandidateOptions, type OcrParseResult, type RawOcrCapture, type OcrBarcode, type ParsedFields } from '~/utils/parseOcrScan';
import type { OcrInput } from './useMockOcr';
import type { SupplierQrcodeTemplate } from '~/services/types';
import type { WarehouseService } from '~/services/warehouse';

let supplierTemplateCache: SupplierQrcodeTemplate[] | null = null;
let supplierTemplateCachePromise: Promise<SupplierQrcodeTemplate[]> | null = null;

async function getCachedSupplierQrTemplates(
  warehouse: WarehouseService
): Promise<SupplierQrcodeTemplate[]> {
  if (supplierTemplateCache) return supplierTemplateCache;
  if (!supplierTemplateCachePromise) {
    supplierTemplateCachePromise = warehouse.getSupplierQrTemplates().then((templates) => {
      supplierTemplateCache = templates;
      return templates;
    });
  }
  return supplierTemplateCachePromise;
}

function parseBarcodes(barcodesJson: string): RawOcrCapture['barcodes'] {
  try {
    const parsed = JSON.parse(barcodesJson);
    if (Array.isArray(parsed)) {
      return parsed.filter(isBarcodeItem);
    }
  } catch {
    // ignore malformed barcode JSON
  }
  return [];
}

// ML Kit Barcode.FORMAT_QR_CODE is serialized as the integer string "4".
const QR_CODE_FORMAT = '4';

function isQrOnlyCapture(
  capture: LabelScanCapture,
  barcodes: ReturnType<typeof parseBarcodes>
): boolean {
  if (capture.imagePath) return false;
  return barcodes.length === 1 && barcodes[0].format === QR_CODE_FORMAT;
}

export type LabelScanResult =
  | { status: 'applied' }
  | {
      status: 'review';
      capture: LabelScanCapture;
      parsed: OcrInput;
      options: CandidateOptions;
      matchResult: ScanMatchResult;
    }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export function buildRawCapture(value: string): LabelScanCapture {
  return {
    imagePath: '',
    text: value,
    barcodes: JSON.stringify([{ value, format: '4' }]),
  };
}

export function useLabelScan() {
  const scanning = ref(false);
  const errorMessage = useErrorMessage();
  const matchers = useScanMatchers();
  const warehouse = useWarehouse();

  async function processCapture(
    capture: LabelScanCapture,
    context: ScanTaskContext
  ): Promise<LabelScanResult> {
    const t0 = performance.now();
    const barcodes = parseBarcodes(capture.barcodes);
    let parsedResult: OcrParseResult;

    if (isQrOnlyCapture(capture, barcodes)) {
      const qrValue = barcodes[0]?.value ?? capture.text;
      console.log('[SCAN-TIME] fetching supplier QR templates...');
      const t1 = performance.now();
      const suppliers = await getCachedSupplierQrTemplates(warehouse);
      console.log('[SCAN-TIME] getSupplierQrTemplates', (performance.now() - t1).toFixed(1), 'ms');
      const t2 = performance.now();
      parsedResult = parseQrCapture(qrValue, {
        supplierTemplates: suppliers,
        targets: context.targets ?? [],
        contextSupplierCode: context.supplierCode,
      });
      console.log('[SCAN-TIME] parseQrCapture', (performance.now() - t2).toFixed(1), 'ms');
    } else {
      const t1 = performance.now();
      parsedResult = parseAndIdentify(
        { text: capture.text, barcodes },
        context.targets ?? []
      );
      console.log('[SCAN-TIME] parseAndIdentify', (performance.now() - t1).toFixed(1), 'ms');
    }

    const parsed = ocrResultToInput(parsedResult.parsed);

    const t3 = performance.now();
    const matchResult = await runScanMatcher(context, parsed, matchers);
    console.log('[SCAN-TIME] runScanMatcher', (performance.now() - t3).toFixed(1), 'ms');

    if (matchResult.type === 'error') {
      return { status: 'error', message: matchResult.message };
    }

    if (matchResult.type === 'single' && !context.confirmSingleMatch) {
      await matchResult.apply();
      return { status: 'applied' };
    }

    console.log('[SCAN-TIME] processCapture total', (performance.now() - t0).toFixed(1), 'ms');
    return {
      status: 'review',
      capture,
      parsed,
      options: parsedResult.options,
      matchResult,
    };
  }

  async function parseRawValue(
    rawValue: string,
    supplierCode?: string
  ): Promise<OcrParseResult> {
    const capture = buildRawCapture(rawValue);
    const barcodes = parseBarcodes(capture.barcodes);

    if (isQrOnlyCapture(capture, barcodes)) {
      const suppliers = await getCachedSupplierQrTemplates(warehouse);
      return parseQrCapture(rawValue, {
        supplierTemplates: suppliers,
        targets: [],
        contextSupplierCode: supplierCode,
      });
    }

    return parseAndIdentify({ text: rawValue, barcodes }, []);
  }

  async function scan(context: ScanTaskContext): Promise<LabelScanResult> {
    scanning.value = true;
    try {
      let capture: LabelScanCapture;
      try {
        capture = await RectangleDetection.scanLabel();
      } catch (e: unknown) {
        if (isCancellationError(e)) {
          return { status: 'cancelled' };
        }
        if (isBrowserUnavailableError(e)) {
          const raw = window.prompt('Paste label QR code value:');
          if (raw === null) {
            return { status: 'cancelled' };
          }
          const simulated = parseBrowserScanPrompt(raw);
          if (!simulated) {
            return { status: 'cancelled' };
          }
          capture = simulated;
        } else {
          throw e;
        }
      }
      return await processCapture(capture, context);
    } catch (e: unknown) {
      const message = e instanceof I18nError ? errorMessage(e) : (e instanceof Error ? e.message : String(e));
      return { status: 'error', message };
    } finally {
      scanning.value = false;
    }
  }

  return { scan, scanning, processCapture, parseRawValue };
}

export function ocrResultToInput(parsed: ParsedFields): OcrInput {
  return {
    partNo: parsed.itemId ?? '',
    dateCode: parsed.dateCode ?? '',
    lotCode: parsed.lotCode ?? '',
    coo: parsed.coo ?? '',
    cow: parsed.cow ?? '',
    qty: parsed.qty ?? '',
  };
}

function isBarcodeItem(b: unknown): b is OcrBarcode {
  return (
    typeof b === 'object' &&
    b !== null &&
    typeof (b as Record<string, unknown>).value === 'string' &&
    typeof (b as Record<string, unknown>).format === 'string'
  );
}

export function parseBrowserScanPromptJson(raw: string): LabelScanCapture | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text !== 'string') return null;

  const barcodes = Array.isArray(obj.barcodes) ? obj.barcodes : [];
  if (!barcodes.every(isBarcodeItem)) return null;

  return {
    imagePath: '',
    text: obj.text,
    barcodes: JSON.stringify(barcodes),
  };
}

export function parseBrowserScanPrompt(raw: string): LabelScanCapture | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const jsonCapture = parseBrowserScanPromptJson(trimmed);
  if (jsonCapture) return jsonCapture;

  return buildRawCapture(trimmed);
}

function isCancellationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('cancel');
}

function isBrowserUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message === SCAN_NOT_AVAILABLE_MESSAGE;
}
