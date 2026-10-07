import { describe, it, expect, beforeEach, vi } from 'vitest';

// Same minimal vue stub the other composable tests use (vue is not a direct
// dependency of @warehouse/pda, so vitest cannot resolve a real import).
vi.mock('vue', () => ({
  ref: <T>(value: T) => ({ value }),
  readonly: <T>(r: T) => r,
  computed: <T>(fn: () => T) => ({ get value() { return fn(); } }),
}));

const {
  reportOutdatedWarning,
  dismissOutdatedWarning,
  useOutdatedWarningState,
} = await import('~/composables/useOutdatedWarning');

function drain() {
  while (useOutdatedWarningState().current.value) dismissOutdatedWarning();
}

describe('useOutdatedWarning', () => {
  beforeEach(drain);

  it('queues reported warnings and ignores null/undefined (clean scans)', () => {
    const { warnings, current } = useOutdatedWarningState();

    reportOutdatedWarning(null);
    reportOutdatedWarning(undefined);
    expect(warnings.value).toEqual([]);

    reportOutdatedWarning({ supplierCode: 'KOA', dateCode: '3724', limitMonths: 12 });
    reportOutdatedWarning({ supplierCode: 'DAITO', dateCode: '0123', limitMonths: 24 });

    expect(warnings.value).toHaveLength(2);
    expect(current.value).toEqual({ supplierCode: 'KOA', dateCode: '3724', limitMonths: 12 });
  });

  it('dismiss reveals the next queued warning', () => {
    const { current } = useOutdatedWarningState();

    reportOutdatedWarning({ supplierCode: 'KOA', dateCode: '3724', limitMonths: 12 });
    reportOutdatedWarning({ supplierCode: 'DAITO', dateCode: '0123', limitMonths: 24 });

    dismissOutdatedWarning();
    expect(current.value).toEqual({ supplierCode: 'DAITO', dateCode: '0123', limitMonths: 24 });

    dismissOutdatedWarning();
    expect(current.value).toBeNull();
  });

  it('registers itself as the scan-warning bus handler', async () => {
    const { emitOutdatedWarning } = await import('~/services/scanWarningBus');

    emitOutdatedWarning({ supplierCode: 'KOA', dateCode: '3724', limitMonths: 12 });
    expect(useOutdatedWarningState().current.value).toEqual({
      supplierCode: 'KOA',
      dateCode: '3724',
      limitMonths: 12,
    });

    emitOutdatedWarning(null);
    expect(useOutdatedWarningState().warnings.value).toHaveLength(1);
  });
});
