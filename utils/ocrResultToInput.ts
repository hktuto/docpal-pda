import type { OcrInput } from '~/composables/useMockOcr';
import type { OcrParseResult } from '~/utils/parseOcrScan';

export function ocrResultToInput(parsed: OcrParseResult['parsed']): OcrInput {
  return {
    partNo: parsed.itemId ?? '',
    dateCode: parsed.dateCode ?? '',
    lotCode: parsed.lotCode ?? '',
    coo: parsed.coo ?? '',
    cow: parsed.cow ?? '',
    qty: parsed.qty ?? '',
  };
}
