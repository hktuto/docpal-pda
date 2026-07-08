import { ref } from 'vue';
import {
  RectangleDetection,
  SCAN_NOT_AVAILABLE_MESSAGE,
  type LabelScanCapture,
} from './useRectangleDetection';
import { runScanMatcher, useScanMatchers, type ScanTaskContext, type ScanMatchResult } from './useScanMatchers';
import { I18nError } from '~/composables/i18nError';
import { useErrorMessage } from '~/composables/errorMessage';
import { useDb } from '~/composables/useDb';
import { parseAndIdentify, parseQrCapture, type CandidateOptions, type OcrParseResult, type RawOcrCapture, type OcrBarcode, type ParsedFields } from '~/utils/parseOcrScan';
import { getSuppliersWithQrTemplates } from '~/db/suppliers';
import type { OcrInput } from './useMockOcr';

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

export function useLabelScan() {
  const scanning = ref(false);
  const errorMessage = useErrorMessage();
  const matchers = useScanMatchers();
  const db = useDb();

  async function processCapture(
    capture: LabelScanCapture,
    context: ScanTaskContext
  ): Promise<LabelScanResult> {
    const barcodes = parseBarcodes(capture.barcodes);
    let parsedResult: OcrParseResult;

    if (isQrOnlyCapture(capture, barcodes)) {
      const qrValue = barcodes[0]?.value ?? capture.text;
      const suppliers = await getSuppliersWithQrTemplates(db);
      parsedResult = parseQrCapture(qrValue, {
        supplierTemplates: suppliers,
        targets: context.targets ?? [],
        contextSupplierCode: context.supplierCode,
      });
    } else {
      parsedResult = parseAndIdentify(
        { text: capture.text, barcodes },
        context.targets ?? []
      );
    }

    const parsed = ocrResultToInput(parsedResult.parsed);

    const matchResult = await runScanMatcher(context, parsed, matchers);

    if (matchResult.type === 'error') {
      return { status: 'error', message: matchResult.message };
    }

    if (matchResult.type === 'single' && !context.confirmSingleMatch) {
      await matchResult.apply();
      return { status: 'applied' };
    }

    return {
      status: 'review',
      capture,
      parsed,
      options: parsedResult.options,
      matchResult,
    };
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
          const raw = window.prompt('Paste scan JSON (text + barcodes):');
          if (raw === null) {
            return { status: 'cancelled' };
          }
          const simulated = parseBrowserScanPromptJson(raw);
          if (!simulated) {
            return { status: 'error', message: 'Invalid scan JSON' };
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

  return { scan, scanning };
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

function isCancellationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('cancel');
}

function isBrowserUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message === SCAN_NOT_AVAILABLE_MESSAGE;
}
