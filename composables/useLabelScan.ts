import { ref } from 'vue';
import {
  RectangleDetection,
  SCAN_NOT_AVAILABLE_MESSAGE,
  type LabelScanCapture,
} from './useRectangleDetection';
import { runScanMatcher, type ScanTaskContext, type ScanMatchResult } from './useScanMatchers';
import { I18nError } from '~/composables/i18nError';
import { useErrorMessage } from '~/composables/errorMessage';
import { parseAndIdentify, type CandidateOptions, type RawOcrCapture } from '~/utils/parseOcrScan';
import { ocrResultToInput } from '~/utils/ocrResultToInput';
import type { OcrInput } from './useMockOcr';

function parseBarcodes(barcodesJson: string): RawOcrCapture['barcodes'] {
  try {
    const parsed = JSON.parse(barcodesJson);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (b): b is { value: string; format: string } =>
          typeof b === 'object' &&
          b !== null &&
          typeof (b as { value?: unknown }).value === 'string' &&
          typeof (b as { format?: unknown }).format === 'string'
      );
    }
  } catch {
    // ignore malformed barcode JSON
  }
  return [];
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
  | { status: 'manual' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export function createManualReview(): Extract<LabelScanResult, { status: 'review' }> {
  return {
    status: 'review',
    capture: { imagePath: '', text: '', barcodes: '[]' },
    parsed: { partNo: '', dateCode: '', lotCode: '', coo: '', cow: '', qty: '' },
    options: { itemIds: [], qtys: [], coos: [], dateCodes: [], lotCodes: [], cows: [] },
    matchResult: { type: 'none' },
  };
}

export function useLabelScan() {
  const scanning = ref(false);
  const errorMessage = useErrorMessage();

  async function scan(context: ScanTaskContext): Promise<LabelScanResult> {
    scanning.value = true;

    try {
      const capture = await RectangleDetection.scanLabel();
      const barcodes = parseBarcodes(capture.barcodes);
      const parsedResult = parseAndIdentify(
        { text: capture.text, barcodes },
        context.targets ?? []
      );
      const parsed = ocrResultToInput(parsedResult.parsed);

      const matchResult = await runScanMatcher(context, parsed);

      if (matchResult.type === 'error') {
        return { status: 'error', message: matchResult.message };
      }

      if (matchResult.type === 'single') {
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
    } catch (e: unknown) {
      if (isCancellationError(e)) {
        return { status: 'cancelled' };
      }
      if (isBrowserUnavailableError(e)) {
        return { status: 'manual' };
      }
      const message = e instanceof I18nError ? errorMessage(e) : (e instanceof Error ? e.message : String(e));
      return { status: 'error', message };
    } finally {
      scanning.value = false;
    }
  }

  return { scan, scanning };
}

function isCancellationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('cancel');
}

function isBrowserUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message === SCAN_NOT_AVAILABLE_MESSAGE;
}
