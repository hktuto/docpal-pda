import { ref } from 'vue';
import { RectangleDetection, type LabelScanCapture } from './useRectangleDetection';
import { useRecognizedTextParser } from './useRecognizedTextParser';
import { runScanMatcher, type ScanTaskContext, type ScanMatchResult } from './useScanMatchers';
import type { OcrInput } from './useMockOcr';

export type LabelScanResult =
  | { status: 'applied' }
  | { status: 'review'; capture: LabelScanCapture; parsed: OcrInput; matchResult: ScanMatchResult }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export function useLabelScan() {
  const scanning = ref(false);
  const error = ref<string | null>(null);
  const { parseRecognizedText } = useRecognizedTextParser();

  async function scan(context: ScanTaskContext): Promise<LabelScanResult> {
    scanning.value = true;
    error.value = null;

    try {
      const capture = await RectangleDetection.scanLabel();
      const parsed = parseRecognizedText(capture.text);
      console.log('[useLabelScan]', { imagePath: capture.imagePath, text: capture.text, parsed });

      const matchResult = await runScanMatcher(context, parsed);

      if (matchResult.type === 'error') {
        error.value = matchResult.message;
        return { status: 'error', message: matchResult.message };
      }

      if (matchResult.type === 'single') {
        await matchResult.apply();
        return { status: 'applied' };
      }

      return { status: 'review', capture, parsed, matchResult };
    } catch (e: unknown) {
      if (isCancellationError(e)) {
        return { status: 'cancelled' };
      }
      const message = e instanceof Error ? e.message : String(e);
      error.value = message;
      return { status: 'error', message };
    } finally {
      scanning.value = false;
    }
  }

  return { scan, scanning, error };
}

function isCancellationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('cancel');
}
