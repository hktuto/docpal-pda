import { describe, it, expect, vi } from 'vitest';
import type { ParsedFields } from '../utils/parseOcrScan';

vi.mock('vue', () => ({
  ref: vi.fn((value) => ({ value })),
}));

vi.mock('../composables/useRectangleDetection', () => ({
  SCAN_NOT_AVAILABLE_MESSAGE: 'scan_not_available_browser',
  RectangleDetection: {},
}));

vi.mock('../composables/useScanMatchers', () => ({
  useScanMatchers: vi.fn(() => ({})),
  runScanMatcher: vi.fn(),
}));

vi.mock('../composables/i18nError', () => ({
  I18nError: class I18nError extends Error {
    constructor(public code: string, public params?: Record<string, unknown>) {
      super(code);
    }
  },
}));

vi.mock('../composables/errorMessage', () => ({
  useErrorMessage: vi.fn(() => (e: unknown) => String(e)),
}));

const { ocrResultToInput, parseBrowserScanPromptJson, buildRawCapture, parseBrowserScanPrompt } = await import('../composables/useLabelScan');

describe('ocrResultToInput', () => {
  it('maps all parsed fields to the matcher input shape', () => {
    const parsed: ParsedFields = {
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
    const parsed: ParsedFields = {
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
    const parsed: ParsedFields = {
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

  it('passes through empty strings and zero qty unchanged', () => {
    const parsed: ParsedFields = { itemId: '', qty: 0 };
    expect(ocrResultToInput(parsed)).toEqual({
      partNo: '',
      dateCode: '',
      lotCode: '',
      coo: '',
      cow: '',
      qty: 0,
    });
  });
});

describe('parseBrowserScanPromptJson', () => {
  it('returns a LabelScanCapture for valid input', () => {
    const result = parseBrowserScanPromptJson(JSON.stringify({
      text: 'PART: RK73B1JTTD181G\nQTY: 5000',
      barcodes: [{ value: 'RK73B1JTTD181G', format: 'CODE_128' }],
    }));

    expect(result).not.toBeNull();
    expect(result!.imagePath).toBe('');
    expect(result!.text).toBe('PART: RK73B1JTTD181G\nQTY: 5000');
    expect(result!.barcodes).toBe('[{"value":"RK73B1JTTD181G","format":"CODE_128"}]');
  });

  it('returns null for invalid JSON', () => {
    expect(parseBrowserScanPromptJson('not json')).toBeNull();
  });

  it('returns null when text is missing', () => {
    expect(parseBrowserScanPromptJson(JSON.stringify({
      barcodes: [{ value: 'X', format: 'CODE_128' }],
    }))).toBeNull();
  });

  it('returns null for a malformed barcode item', () => {
    expect(parseBrowserScanPromptJson(JSON.stringify({
      text: 'X',
      barcodes: [{ value: 'X' }],
    }))).toBeNull();
  });

  it('accepts an empty barcodes array', () => {
    const result = parseBrowserScanPromptJson(JSON.stringify({
      text: 'X',
      barcodes: [],
    }));
    expect(result).not.toBeNull();
    expect(result!.barcodes).toBe('[]');
  });

  it('defaults missing barcodes to an empty array', () => {
    const result = parseBrowserScanPromptJson(JSON.stringify({
      text: 'X',
    }));
    expect(result).not.toBeNull();
    expect(result!.barcodes).toBe('[]');
  });

  it('returns null when a barcode entry is null', () => {
    expect(parseBrowserScanPromptJson(JSON.stringify({
      text: 'X',
      barcodes: [null],
    }))).toBeNull();
  });

  it('returns null when a barcode entry is a number', () => {
    expect(parseBrowserScanPromptJson(JSON.stringify({
      text: 'X',
      barcodes: [42],
    }))).toBeNull();
  });

  it('returns null when a barcode entry is a string', () => {
    expect(parseBrowserScanPromptJson(JSON.stringify({
      text: 'X',
      barcodes: ['string'],
    }))).toBeNull();
  });
});

describe('parseBrowserScanPrompt', () => {
  it('parses valid JSON input', () => {
    const raw = JSON.stringify({
      text: ':RK73H1ETTP1000F::24:X:9827002:602:KOA+RK73H1ETTP1000F::::',
      barcodes: [{ value: '123', format: '4' }],
    });
    const result = parseBrowserScanPrompt(raw);
    expect(result).not.toBeNull();
    expect(result!.text).toBe(':RK73H1ETTP1000F::24:X:9827002:602:KOA+RK73H1ETTP1000F::::');
    expect(result!.barcodes).toBe(JSON.stringify([{ value: '123', format: '4' }]));
  });

  it('falls back to treating non-JSON input as a QR-code string', () => {
    const raw = ':RK73H1ETTP1000F::24:X:9827002:602:KOA+RK73H1ETTP1000F::::';
    const result = parseBrowserScanPrompt(raw);
    expect(result).toEqual(buildRawCapture(raw));
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(parseBrowserScanPrompt('')).toBeNull();
    expect(parseBrowserScanPrompt('   ')).toBeNull();
  });
});
