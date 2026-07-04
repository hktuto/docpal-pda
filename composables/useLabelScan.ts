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
import { parseBrowserScanPromptJson } from '~/utils/parseBrowserScanPromptJson';
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
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

async function processCapture(
  capture: LabelScanCapture,
  context: ScanTaskContext
): Promise<LabelScanResult> {
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
}

export function useLabelScan() {
  const scanning = ref(false);
  const errorMessage = useErrorMessage();

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

function isCancellationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('cancel');
}

function isBrowserUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message === SCAN_NOT_AVAILABLE_MESSAGE;
}
