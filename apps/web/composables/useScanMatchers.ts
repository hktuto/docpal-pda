import { parseManual, normalize } from './useMockOcr';
import { useAuth } from './useAuth';
import { useWarehouse } from './useWarehouse';
import { useDb } from './useDb';
import { findReceivingCandidates, findPickingCandidates, findReceivingCandidatesForOrder, findPickingCandidatesForOrder } from '~/db/ocrPicking';
import { I18nError } from '~/composables/i18nError';
import type { OcrInput } from './useMockOcr';
import type {
  ReceivingCandidate,
  PickingCandidate,
  PutAwayLot,
  PackageVerificationInput,
  GoodsVerifyShelfBoxItem,
} from '~/services/types';
import { rawCode } from '~/utils/text';

export type ScanTask = 'receiving' | 'picking' | 'put-away' | 'measuring' | 'goods-verify';

export async function runScanMatcher(
  ctx: ScanTaskContext,
  parsed: OcrInput,
  matchers: ScanMatchers
): Promise<ScanMatchResult> {
  const m = matchers;
  switch (ctx.task) {
    case 'receiving':
      if (!ctx.receivingOrderId) return m.error('missing_receiving_order_id');
      return m.matchReceiving(ctx, parsed);
    case 'picking':
      if (!ctx.allocation) return m.error('missing_allocation');
      return m.matchPicking(ctx.allocation, parsed);
    case 'put-away':
      if (!ctx.receivingItem) return m.error('missing_receiving_item');
      return m.matchPutAway(ctx.receivingItem, parsed);
    case 'measuring':
      if (!ctx.boxId) return m.error('missing_box_id');
      return m.matchMeasuring(ctx.boxId, ctx.targetPackageId, parsed);
    case 'goods-verify':
      if (!ctx.items) return m.error('missing_box_items');
      return m.matchGoodsVerify(ctx.items, parsed);
    default:
      return m.error('unknown_scan_task');
  }
}

interface PickingAllocation {
  id: string;
  qty: number;
  receivingOrder?: { id: string } | null;
  pickingItem?: { id: string; part?: { partNo: string | null } | null } | null;
}

export interface ScanTaskContext {
  task: ScanTask;
  targets?: string[];
  // receiving / picking
  receivingOrderId?: string;
  pickingItemId?: string;
  supplierCode?: string;
  receivingCandidatesByPartNo?: Map<string, ReceivingCandidate[]>;
  pickingCandidatesByPartId?: Map<string, PickingCandidate[]>;
  // picking
  allocation?: PickingAllocation;
  // put-away
  receivingItem?: PutAwayLot;
  // measuring
  boxId?: string;
  targetPackageId?: string;
  // goods-verify
  items?: GoodsVerifyShelfBoxItem[];
  // when true, even a single match opens the review dialog instead of auto-applying
  confirmSingleMatch?: boolean;
}

export interface ScanMatchRecord {
  record: unknown;
  apply: () => Promise<void>;
}

export type ScanMatchResult =
  | { type: 'single'; record: unknown; apply: () => Promise<void> }
  | { type: 'multiple'; records: ScanMatchRecord[] }
  | { type: 'none' }
  | { type: 'error'; message: string };

export interface ScanMatchers {
  matchReceiving(ctx: ScanTaskContext, parsed: OcrInput): Promise<ScanMatchResult>;
  matchPicking(allocation: PickingAllocation, parsed: OcrInput): Promise<ScanMatchResult>;
  matchPutAway(receivingItem: PutAwayLot, parsed: OcrInput): Promise<ScanMatchResult>;
  matchMeasuring(boxId: string, targetPackageId: string | undefined, parsed: OcrInput): Promise<ScanMatchResult>;
  matchGoodsVerify(items: GoodsVerifyShelfBoxItem[], parsed: OcrInput): Promise<ScanMatchResult>;
  error(err: I18nError): ScanMatchResult;
  error(code: string, params?: Record<string, unknown>): ScanMatchResult;
}

export function findUnverifiedBoxItemByPartNo(
  items: GoodsVerifyShelfBoxItem[],
  scannedPartNo: string
): GoodsVerifyShelfBoxItem | undefined {
  const normalizedScannedPartNo = normalize(scannedPartNo);
  return items.find((i) =>
    !i.verified && normalize(i.part?.partNo ?? '') === normalizedScannedPartNo
  );
}

export function useScanMatchers(): ScanMatchers {
  const warehouse = useWarehouse();
  const db = useDb();
  const { currentUser } = useAuth();
  const { t } = useI18n();

  function error(arg: I18nError | string, params?: Record<string, unknown>): ScanMatchResult {
    if (arg instanceof I18nError) {
      return { type: 'error', message: t(`errors.${arg.code}`, (arg.params ?? {}) as Record<string, unknown>) };
    }
    return { type: 'error', message: t(`errors.${arg}`, params ?? {}) };
  }

  async function matchReceiving(ctx: ScanTaskContext, parsed: OcrInput): Promise<ScanMatchResult> {
    try {
      const t0 = performance.now();
      const user = currentUser.value;
      if (!user?.id) return error('operator_not_signed_in');

      const receivingOrderId = ctx.receivingOrderId;
      if (!receivingOrderId) return error('missing_receiving_order_id');
      const pickingItemId = ctx.pickingItemId;

      const p = parseManual(parsed);
      const t1 = performance.now();
      let receivingCandidates: ReceivingCandidate[];
      if (ctx.receivingCandidatesByPartNo) {
        receivingCandidates = ctx.receivingCandidatesByPartNo.get(p.partNo) ?? [];
        console.log('[SCAN-TIME] receivingCandidates cache lookup', (performance.now() - t1).toFixed(1), 'ms');
      } else {
        receivingCandidates = await findReceivingCandidates(db, receivingOrderId, p);
        console.log('[SCAN-TIME] findReceivingCandidates', (performance.now() - t1).toFixed(1), 'ms');
      }
      if (receivingCandidates.length === 0) return { type: 'none' };
      const receiving = receivingCandidates[0];
      if (p.qty > receiving.availableQty) return { type: 'none' };

      const t2 = performance.now();
      let pickingCandidates: PickingCandidate[];
      if (ctx.pickingCandidatesByPartId) {
        pickingCandidates = ctx.pickingCandidatesByPartId.get(receiving.partId)?.filter((c) => c.remainingQty >= p.qty) ?? [];
        console.log('[SCAN-TIME] pickingCandidates cache lookup', (performance.now() - t2).toFixed(1), 'ms');
      } else {
        pickingCandidates = await findPickingCandidates(db, receivingOrderId, receiving.partId, p.qty);
        console.log('[SCAN-TIME] findPickingCandidates', (performance.now() - t2).toFixed(1), 'ms');
      }
      if (pickingItemId) {
        pickingCandidates = pickingCandidates.filter((c) => c.pickingItemId === pickingItemId);
      }
      if (pickingCandidates.length === 0) return { type: 'none' };
      console.log('[SCAN-TIME] matchReceiving total', (performance.now() - t0).toFixed(1), 'ms');

      const applyFor = (picking: PickingCandidate) => async () => {
        const actorId = currentUser.value?.id;
        if (!actorId) throw new I18nError('operator_not_signed_in');
        const qty = p.qty;
        if (!Number.isInteger(qty) || qty <= 0) throw new I18nError('invalid_quantity_to_apply');
        if (qty > receiving.availableQty) throw new I18nError('quantity_not_available_receiving');
        if (qty > picking.remainingQty) throw new I18nError('quantity_exceeds_picking_need');
        await warehouse.applyOcrPick({
          receivingOrderId: ctx.receivingOrderId!,
          pickingItemId: picking.pickingItemId,
          qty,
          dateCode: receiving.dateCode,
          lotCode: receiving.lotCode,
          coo: receiving.coo,
          cow: receiving.cow,
        });
      };

      if (pickingCandidates.length === 1) {
        const picking = pickingCandidates[0];
        return { type: 'single', record: { receiving, picking }, apply: applyFor(picking) };
      }

      return {
        type: 'multiple',
        records: pickingCandidates.map((picking) => ({ record: { receiving, picking }, apply: applyFor(picking) })),
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'receiving' }));
    }
  }

  async function matchPicking(allocation: PickingAllocation, parsed: OcrInput): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('operator_not_signed_in');

      const scannedPartNo = normalize(parsed.partNo ?? '');
      const expectedPartNo = normalize(allocation?.pickingItem?.part?.partNo ?? '');
      if (!scannedPartNo) return { type: 'none' };
      if (scannedPartNo !== expectedPartNo) return error('scanned_part_does_not_match_allocation');

      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');
      if (!allocation?.qty) return error('invalid_allocation');
      if (qty > allocation.qty) return error('qty_exceeds_allocated');

      const dateCode = rawCode(parsed.dateCode);
      const lotCode = rawCode(parsed.lotCode);
      const coo = rawCode(parsed.coo);
      const cow = rawCode(parsed.cow);

      const isReceivingAllocation = !!allocation?.receivingOrder;

      return {
        type: 'single',
        record: allocation,
        apply: async () => {
          const actorId = currentUser.value?.id;
          if (!actorId) throw new I18nError('operator_not_signed_in');
          if (isReceivingAllocation) {
            await warehouse.applyOcrPick({
              receivingOrderId: allocation.receivingOrder!.id,
              pickingItemId: allocation.pickingItem!.id,
              qty,
              dateCode,
              lotCode,
              coo,
              cow,
            });
          } else {
            await warehouse.scanAllocation(allocation.id, qty);
          }
        },
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'picking' }));
    }
  }

  async function matchPutAway(receivingItem: PutAwayLot, parsed: OcrInput): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('operator_not_signed_in');

      const scannedPartNo = normalize(parsed.partNo ?? '');
      const expectedPartNo = normalize(receivingItem.partNo ?? '');
      if (!scannedPartNo) return { type: 'none' };
      if (scannedPartNo !== expectedPartNo) return error('scanned_part_does_not_match_item');

      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');
      if (!receivingItem?.receivingInvoiceItemId) return error('invalid_receiving_item');
      if (qty > (receivingItem.availableQty ?? 0)) return error('quantity_exceeds_available');

      const dateCode = rawCode(parsed.dateCode);
      const lotCode = rawCode(parsed.lotCode);
      const coo = rawCode(parsed.coo);
      const cow = rawCode(parsed.cow);

      return {
        type: 'single',
        record: receivingItem,
        apply: async () => {
          const actorId = currentUser.value?.id;
          if (!actorId) throw new I18nError('operator_not_signed_in');
          await warehouse.recordPutAwayScan(
            receivingItem.receivingInvoiceItemId,
            qty,
            dateCode,
            lotCode,
            coo,
            cow
          );
        },
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'put-away' }));
    }
  }

  async function matchMeasuring(boxId: string, targetPackageId: string | undefined, parsed: OcrInput): Promise<ScanMatchResult> {
    const user = currentUser.value;
    if (!user?.id) return error('operator_not_signed_in');

    try {
      if (!parsed.partNo?.trim()) return error('part_no_required');
      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');

      const input: PackageVerificationInput = {
        partNo: parsed.partNo,
        dateCode: parsed.dateCode ?? '',
        lotCode: parsed.lotCode ?? '',
        coo: parsed.coo ?? '',
        cow: parsed.cow ?? '',
        qty,
      };
      const matched = await warehouse.findMatchingUnverifiedPackage(boxId, input, targetPackageId);

      if (!matched) return { type: 'none' };

      return {
        type: 'single',
        record: matched,
        apply: async () => {
          const actorId = currentUser.value?.id;
          if (!actorId) throw new I18nError('operator_not_signed_in');
          await warehouse.verifyPickingPackage(matched.id);
        },
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'measuring' }));
    }
  }

  async function matchGoodsVerify(items: GoodsVerifyShelfBoxItem[], parsed: OcrInput): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('operator_not_signed_in');

      const scannedPartNo = normalize(parsed.partNo ?? '');
      if (!scannedPartNo) return error('part_no_required');

      const item = findUnverifiedBoxItemByPartNo(items, scannedPartNo);
      if (!item) return error('part_not_found_in_box');

      return {
        type: 'single',
        record: item,
        apply: () => warehouse.verifyShelfBoxItem(item.shelfBoxId, item.partId),
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'goods-verify' }));
    }
  }

  return {
    matchReceiving,
    matchPicking,
    matchPutAway,
    matchMeasuring,
    matchGoodsVerify,
    error,
  };
}
