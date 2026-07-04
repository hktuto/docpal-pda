import { describe, it, expect } from 'vitest';
import { parseBrowserScanPromptJson } from '../utils/parseBrowserScanPromptJson';

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
