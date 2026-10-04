import { describe, it, expect, vi } from 'vitest';

// vue is not a direct dependency (comes via nuxt), so mock it like the other
// composable tests do.
vi.mock('vue', () => ({
  ref: (value: unknown) => ({ value }),
  computed: (fn: () => unknown) => ({ get value() { return fn(); } }),
  watch: () => {},
  onUnmounted: () => {},
}));

const { brandWhitelistUnion, withShelfSymbologies } = await import('~/composables/useScannerConfig');

const templates = [
  { code: '32', brands: ['KOA'], barcodeTypes: ['PDF417'] },
  { code: '70915', brands: ['SII'], barcodeTypes: ['QR CODE'] },
  { code: '84915', brands: ['ABLIC'], barcodeTypes: ['QR CODE'] },
  { code: '19915', brands: ['COPAL', 'NIDEC'], barcodeTypes: null },
  { code: '1', brands: null, barcodeTypes: null },
];

describe('brandWhitelistUnion', () => {
  it('returns the whitelist of the single matching brand', () => {
    expect(brandWhitelistUnion(templates, ['KOA'])).toEqual(['PDF417']);
  });

  it('unions whitelists across mixed-brand orders', () => {
    expect(brandWhitelistUnion(templates, ['KOA', 'SII'])).toEqual(['PDF417', 'QR CODE']);
  });

  it('dedupes a shared symbology', () => {
    expect(brandWhitelistUnion(templates, ['SII', 'ABLIC'])).toEqual(['QR CODE']);
  });

  it('returns null when any brand has no whitelisted profile', () => {
    // COPAL maps to a profile but has no barcodeTypes; UNKNOWN maps to nothing
    expect(brandWhitelistUnion(templates, ['KOA', 'COPAL'])).toBeNull();
    expect(brandWhitelistUnion(templates, ['KOA', 'UNKNOWN'])).toBeNull();
  });

  it('returns null for an empty brand list', () => {
    expect(brandWhitelistUnion(templates, [])).toBeNull();
  });
});

describe('withShelfSymbologies', () => {
  it('unions the shelf-code symbologies into a whitelist missing them', () => {
    expect(withShelfSymbologies(['PDF417'])).toEqual(['PDF417', 'QR CODE']);
  });

  it('leaves a whitelist that already has them unchanged (deduped)', () => {
    expect(withShelfSymbologies(['QR CODE'])).toEqual(['QR CODE']);
  });

  it('passes null (no restriction) through untouched', () => {
    expect(withShelfSymbologies(null)).toBeNull();
  });
});
