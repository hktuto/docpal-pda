import { describe, it, expect, vi } from 'vitest';

// vue is not a direct dependency (comes via nuxt), so mock it like the other
// composable tests do. watch runs immediate callbacks so the symbology
// scopes' applyFor actually executes here.
vi.mock('vue', () => ({
  ref: (value: unknown) => ({ value }),
  computed: (fn: () => unknown) => ({ get value() { return fn(); } }),
  watch: (source: { value: unknown }, cb: (v: never) => void, opts?: { immediate?: boolean }) => {
    if (opts?.immediate) cb(source.value as never);
  },
  onUnmounted: () => {},
}));

// The symbology scopes pull getCachedSupplierQrTemplates (useLabelScan) and
// useWarehouse — stub both so no service chain loads in tests.
vi.mock('~/composables/useLabelScan', () => ({
  getCachedSupplierQrTemplates: async () => [
    { code: '32', brands: ['KOA'], barcodeTypes: ['PDF417'] },
  ],
}));
vi.mock('~/composables/useWarehouse', () => ({
  useWarehouse: () => ({}),
}));

// Plain vi.fn plugin stubs so tests can assert the calls the scopes make.
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    setSymbologies: vi.fn(async () => {}),
    restoreAll: vi.fn(async () => {}),
    getDeviceInfo: vi.fn(async () => ({ brand: '', manufacturer: '', model: '', platform: 'none' })),
  }),
}));

const { brandWhitelistUnion, withShelfSymbologies, ScannerConfig, useBrandSymbologyScope } =
  await import('~/composables/useScannerConfig');
const { ref } = await import('vue');

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

describe('scan-all-symbologies setting gate (Settings page opt-out)', () => {
  const setSymbologies = vi.mocked(ScannerConfig.setSymbologies);
  // The scope serializes plugin calls through a microtask chain — one
  // macrotask tick flushes them.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never restricts the decoder when the setting is on', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '1', setItem: () => {} });
    useBrandSymbologyScope(ref(['KOA']));
    await flush();
    expect(setSymbologies).not.toHaveBeenCalled();
  });

  it('applies the brand-union whitelist when the setting is off', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    useBrandSymbologyScope(ref(['KOA']));
    await flush();
    expect(setSymbologies).toHaveBeenCalledWith({ enabled: ['PDF417'] });
  });
});
