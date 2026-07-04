import { describe, it, expect } from 'vitest';
import { ocrResultToInput } from '../utils/ocrResultToInput';
import type { OcrParseResult } from '../utils/parseOcrScan';

describe('ocrResultToInput', () => {
  it('maps all parsed fields to the matcher input shape', () => {
    const parsed: OcrParseResult['parsed'] = {
      itemId: 'RK73B1JTTD181G',
      qty: 5000,
      coo: 'JP',
      dateCode: '2544',
      lotCode: 'VTCJ9X17324-0134',
      cow: 'W1-2024A',
    };

    expect(ocrResultToInput(parsed)).toEqual({
      partNo: 'RK73B1JTTD181G',
      dateCode: '2544',
      lotCode: 'VTCJ9X17324-0134',
      coo: 'JP',
      cow: 'W1-2024A',
      qty: 5000,
    });
  });

  it('defaults missing values to empty strings and empty qty', () => {
    const parsed: OcrParseResult['parsed'] = {
      itemId: null,
    };

    expect(ocrResultToInput(parsed)).toEqual({
      partNo: '',
      dateCode: '',
      lotCode: '',
      coo: '',
      cow: '',
      qty: '',
    });
  });

  it('defaults individual missing fields to empty strings', () => {
    const parsed: OcrParseResult['parsed'] = {
      itemId: 'RK73B1JTTD181G',
      qty: undefined,
      coo: 'JP',
      dateCode: undefined,
      lotCode: 'VTCJ9X17324-0134',
      cow: undefined,
    };

    expect(ocrResultToInput(parsed)).toEqual({
      partNo: 'RK73B1JTTD181G',
      dateCode: '',
      lotCode: 'VTCJ9X17324-0134',
      coo: 'JP',
      cow: '',
      qty: '',
    });
  });
});
