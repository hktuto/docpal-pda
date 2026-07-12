import { describe, it, expect, vi } from 'vitest';
import type { ScanCandidates } from '../services/types';

const mocks = vi.hoisted(() => ({
  getScanCandidates: vi.fn(),
  applyOcrPick: vi.fn(),
}));

vi.mock('../composables/useWarehouse', () => ({
  useWarehouse: () => ({
    getScanCandidates: mocks.getScanCandidates,
    applyOcrPick: mocks.applyOcrPick,
  }),
}));

vi.mock('../composables/useAuth', () => ({
  useAuth: () => ({ currentUser: { value: { id: 'user-1' } } }),
}));

vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));

const { useScanMatchers } = await import('../composables/useScanMatchers');

function receivingCandidate(itemId: string, availableQty: number) {
  return {
    receivingInvoiceItemId: itemId,
    partId: 'part-1',
    partNo: 'ABC 123',
    dateCode: null,
    lotCode: null,
    coo: null,
    cow: null,
    availableQty,
  };
}

function candidatesWith(receiving: ReturnType<typeof receivingCandidate>[]): ScanCandidates {
  return {
    receivingCandidatesByPartNo: { 'ABC 123': receiving },
    pickingCandidatesByPartId: {
      'part-1': [
        {
          pickingOrderId: 'po-1',
          pickingOrderRefNo: 'PO-1',
          pickingItemId: 'pi-1',
          partId: 'part-1',
          shipTo: null,
          requiredQty: 500,
          pickedQty: 0,
          remainingQty: 500,
        },
      ],
    },
  };
}

describe('matchReceiving candidate selection', () => {
  it('selects the first sufficient candidate when the earliest row lacks qty', async () => {
    mocks.getScanCandidates.mockResolvedValue(
      candidatesWith([receivingCandidate('rii-short', 50), receivingCandidate('rii-full', 200)])
    );

    const matchers = useScanMatchers();
    const result = await matchers.matchReceiving(
      { task: 'receiving', receivingOrderId: 'ro-1' },
      { partNo: 'abc 123', qty: 100, dateCode: '', lotCode: '', coo: '', cow: '' }
    );

    expect(result.type).toBe('single');
    if (result.type === 'single') {
      const record = result.record as { receiving: { receivingInvoiceItemId: string } };
      expect(record.receiving.receivingInvoiceItemId).toBe('rii-full');
    }
  });

  it('returns none when no candidate has sufficient qty', async () => {
    mocks.getScanCandidates.mockResolvedValue(
      candidatesWith([receivingCandidate('rii-short', 50), receivingCandidate('rii-mid', 80)])
    );

    const matchers = useScanMatchers();
    const result = await matchers.matchReceiving(
      { task: 'receiving', receivingOrderId: 'ro-1' },
      { partNo: 'ABC 123', qty: 100, dateCode: '', lotCode: '', coo: '', cow: '' }
    );

    expect(result.type).toBe('none');
  });
});
