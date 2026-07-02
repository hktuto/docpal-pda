import { ref } from 'vue';
import { RectangleDetection, type LabelScanCapture } from './useRectangleDetection';
import { useRecognizedTextParser } from './useRecognizedTextParser';
import { useScanMatchers, type ScanTaskContext, type ScanMatchResult } from './useScanMatchers';
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
  const matchers = useScanMatchers();

  async function scan(context: ScanTaskContext): Promise<LabelScanResult> {
    scanning.value = true;
    error.value = null;

    try {
      const capture = await RectangleDetection.scanLabel();
      const parsed = parseRecognizedText(capture.text);
      console.log('[useLabelScan]', { imagePath: capture.imagePath, text: capture.text, parsed });

      const matchResult = await runMatcher(context, parsed);

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

  async function runMatcher(context: ScanTaskContext, parsed: OcrInput): Promise<ScanMatchResult> {
    switch (context.task) {
      case 'receiving':
        if (!context.receivingOrderId) return { type: 'error', message: 'Missing receiving order ID' };
        return matchers.matchReceiving(context.receivingOrderId, context.pickingItemId, parsed);
      case 'picking':
        if (!context.allocation) return { type: 'error', message: 'Missing allocation' };
        return matchers.matchPicking(context.allocation, parsed);
      case 'put-away':
        if (!context.receivingItem) return { type: 'error', message: 'Missing receiving item' };
        if (!context.targetBoxId) return { type: 'error', message: 'Missing target box' };
        return matchers.matchPutAway(context.receivingItem, context.targetBoxId, parsed);
      case 'measuring':
        if (!context.boxId) return { type: 'error', message: 'Missing box ID' };
        return matchers.matchMeasuring(context.boxId, context.targetPackageId, parsed);
      case 'goods-verify':
        if (!context.items) return { type: 'error', message: 'Missing box items' };
        return matchers.matchGoodsVerify(context.items, parsed);
      default:
        return { type: 'error', message: 'Unknown scan task' };
    }
  }

  return { scan, scanning, error };
}

function isCancellationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('cancel');
}
