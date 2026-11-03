// decodeLabel — endpoint-first decode with the client's no-DB fallback
// (cutover of parseQrCapture, spec 2026-11-03-backend-scan-decode-design.md).
// The backend covers the template loop itself (apps/backend/src/decode/);
// what must hold client-side is: pass-through on matched, and parseAndIdentify
// on matched:false — exactly what parseQrCapture did.

import { describe, expect, it } from 'vitest';
import { decodeLabel } from '../utils/labelDecode';
import type { WarehouseService } from '../services/warehouse';
import type { ScanDecodeInput, ScanDecodeResult } from '../services/types';

function stubWarehouse(result: ScanDecodeResult): WarehouseService {
  return {
    decodeScan: async (_input: ScanDecodeInput) => result,
  } as unknown as WarehouseService;
}

const NOT_FOUND: ScanDecodeResult = {
  matched: false,
  parsed: { itemId: null },
  options: { itemIds: [], qtys: [], coos: [], dateCodes: [], lotCodes: [], cows: [] },
};

describe('decodeLabel', () => {
  it('passes the backend decode through with the client capture as raw', async () => {
    const decoded: ScanDecodeResult = {
      matched: true,
      parsed: { itemId: 'RK73H2ATTD2403F', qty: 25000 },
      options: { itemIds: ['RK73H2ATTD2403F'], qtys: [25000], coos: [], dateCodes: [], lotCodes: [], cows: [] },
      supplier: { code: 'KOA', brands: ['KOA'] },
    };
    const result = await decodeLabel(stubWarehouse(decoded), ':RK73H2ATTD2403F::253:M:63048349:S613:X', {
      targets: ['RK73H2ATTD2403F'],
    });

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe('RK73H2ATTD2403F');
    expect(result.supplier?.code).toBe('KOA');
    expect(result.raw).toEqual({ text: ':RK73H2ATTD2403F::253:M:63048349:S613:X', barcodes: [] });
  });

  it('falls back to the generic part-number heuristics when no template matched', async () => {
    const result = await decodeLabel(stubWarehouse(NOT_FOUND), 'PART: RK73B1JTTD181G', {
      targets: ['RK73B1JTTD181G'],
    });

    expect(result.matched).toBe(true);
    expect(result.parsed.itemId).toBe('RK73B1JTTD181G');
  });

  it('stays unmatched when neither the backend nor the heuristics find a target', async () => {
    const result = await decodeLabel(stubWarehouse(NOT_FOUND), 'random label text', {
      targets: ['SOME-OTHER-PART'],
    });

    expect(result.matched).toBe(false);
    expect(result.parsed.itemId).toBeNull();
  });

  it('forwards the order context to the backend input', async () => {
    const calls: ScanDecodeInput[] = [];
    const warehouse = {
      decodeScan: async (input: ScanDecodeInput) => {
        calls.push(input);
        return NOT_FOUND;
      },
    } as unknown as WarehouseService;

    await decodeLabel(warehouse, 'CODE', { targets: ['A', 'B'], supplierCode: 'KOA', brands: ['TE'] });

    expect(calls[0]).toEqual({ raw: 'CODE', targets: ['A', 'B'], supplierCode: 'KOA', brands: ['TE'] });
  });
});
