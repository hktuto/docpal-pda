import { useDb } from './useDb';
import { parseManual, normalize } from './useMockOcr';
import { useAuth } from './useAuth';
import { I18nError } from '~/composables/i18nError';
import type { OcrInput } from './useMockOcr';
import type { PickingCandidate } from '~/db/ocrPicking';
import type { PutAwayLot } from '~/db/putAway';
import {
  findReceivingCandidates,
  findPickingCandidates,
  applyOcrPick,
} from '~/db/ocrPicking';
import {
  materializeReceivingAllocation,
  scanAllocationToPackage,
} from '~/db/picking';
import { addItemToShelfBox } from '~/db/putAway';
import {
  findMatchingUnverifiedPackage,
  verifyPickingPackageForMeasuring,
} from '~/db/measuring';
import { verifyShelfBoxItem } from '~/db/goodsVerify';

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
      return m.matchReceiving(ctx.receivingOrderId, ctx.pickingItemId, parsed);
    case 'picking':
      if (!ctx.allocation) return m.error('missing_allocation');
      return m.matchPicking(ctx.allocation, parsed);
    case 'put-away':
      if (!ctx.receivingItem) return m.error('missing_receiving_item');
      if (!ctx.targetBoxId) return m.error('missing_target_box');
      return m.matchPutAway(ctx.receivingItem, ctx.targetBoxId, parsed);
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
  receivingInvoiceItem?: unknown;
  pickingItem?: { part?: { partNo: string | null } | null } | null;
}

interface BoxItem {
  id: string;
  verified: boolean;
  part?: { partNo: string | null } | null;
}

function rawCode(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

export interface ScanTaskContext {
  task: ScanTask;
  targets?: string[];
  // receiving / picking
  receivingOrderId?: string;
  pickingItemId?: string;
  // picking
  allocation?: PickingAllocation;
  // put-away
  receivingItem?: PutAwayLot;
  targetBoxId?: string;
  // measuring
  boxId?: string;
  targetPackageId?: string;
  // goods-verify
  shelfBoxId?: string;
  items?: BoxItem[];
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
  matchReceiving(receivingOrderId: string, pickingItemId: string | undefined, parsed: OcrInput): Promise<ScanMatchResult>;
  matchPicking(allocation: PickingAllocation, parsed: OcrInput): Promise<ScanMatchResult>;
  matchPutAway(receivingItem: PutAwayLot, targetBoxId: string, parsed: OcrInput): Promise<ScanMatchResult>;
  matchMeasuring(boxId: string, targetPackageId: string | undefined, parsed: OcrInput): Promise<ScanMatchResult>;
  matchGoodsVerify(items: BoxItem[], parsed: OcrInput): Promise<ScanMatchResult>;
  error(err: I18nError): ScanMatchResult;
  error(code: string, params?: Record<string, unknown>): ScanMatchResult;
}

export function useScanMatchers(): ScanMatchers {
  const db = useDb();
  const { currentUser } = useAuth();
  const { t } = useI18n();

  function error(err: I18nError): ScanMatchResult;
  function error(code: string, params?: Record<string, unknown>): ScanMatchResult;
  function error(arg: I18nError | string, params?: Record<string, unknown>): ScanMatchResult {
    if (arg instanceof I18nError) {
      return { type: 'error', message: t(`errors.${arg.code}`, (arg.params ?? {}) as Record<string, unknown>) };
    }
    return { type: 'error', message: t(`errors.${arg}`, params ?? {}) };
  }

  async function matchReceiving(
    receivingOrderId: string,
    pickingItemId: string | undefined,
    parsed: OcrInput
  ): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('operator_not_signed_in');

      const p = parseManual(parsed);
      const receivingCandidates = await findReceivingCandidates(db, receivingOrderId, p);
      if (receivingCandidates.length === 0) return { type: 'none' };
      const receiving = receivingCandidates[0];
      if (p.qty > receiving.availableQty) return { type: 'none' };

      let pickingCandidates = await findPickingCandidates(db, receivingOrderId, receiving.partId, p.qty);
      if (pickingItemId) {
        pickingCandidates = pickingCandidates.filter((c) => c.pickingItemId === pickingItemId);
      }
      if (pickingCandidates.length === 0) return { type: 'none' };

      const applyFor = (picking: PickingCandidate) => async () => {
        const actorId = currentUser.value?.id;
        if (!actorId) throw new I18nError('operator_not_signed_in');
        const qty = p.qty;
        if (!Number.isInteger(qty) || qty <= 0) throw new I18nError('invalid_quantity_to_apply');
        if (qty > receiving.availableQty) throw new I18nError('quantity_not_available_receiving');
        if (qty > picking.remainingQty) throw new I18nError('quantity_exceeds_picking_need');
        await applyOcrPick(
          db,
          receiving.receivingInvoiceItemId,
          picking.pickingItemId,
          qty,
          receiving.dateCode,
          receiving.lotCode,
          receiving.coo,
          receiving.cow,
          actorId
        );
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

      const isReceivingAllocation = !!allocation?.receivingInvoiceItem;

      return {
        type: 'single',
        record: allocation,
        apply: async () => {
          const actorId = currentUser.value?.id;
          if (!actorId) throw new I18nError('operator_not_signed_in');
          if (isReceivingAllocation) {
            const materializedId = await materializeReceivingAllocation(
              db,
              allocation.id,
              qty,
              dateCode,
              lotCode,
              coo,
              cow
            );
            await scanAllocationToPackage(db, materializedId, qty, actorId);
          } else {
            await scanAllocationToPackage(db, allocation.id, qty, actorId);
          }
        },
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'picking' }));
    }
  }

  async function matchPutAway(receivingItem: PutAwayLot, targetBoxId: string, parsed: OcrInput): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('operator_not_signed_in');

      const scannedPartNo = normalize(parsed.partNo ?? '');
      const expectedPartNo = normalize(receivingItem.part_no ?? '');
      if (!scannedPartNo) return { type: 'none' };
      if (scannedPartNo !== expectedPartNo) return error('scanned_part_does_not_match_item');

      if (!targetBoxId) return error('select_open_box');
      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');
      if (!receivingItem?.receiving_invoice_item_id) return error('invalid_receiving_item');
      if (qty > (receivingItem.available_qty ?? 0)) return error('quantity_exceeds_available');

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
          await addItemToShelfBox(
            db,
            targetBoxId,
            receivingItem.receiving_invoice_item_id,
            qty,
            dateCode,
            lotCode,
            coo,
            cow,
            actorId
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

      const matched = await findMatchingUnverifiedPackage(
        db,
        boxId,
        {
          partNo: parsed.partNo,
          dateCode: parsed.dateCode ?? '',
          lotCode: parsed.lotCode ?? '',
          coo: parsed.coo ?? '',
          cow: parsed.cow ?? '',
          qty,
        },
        targetPackageId
      );

      if (!matched) return { type: 'none' };

      return {
        type: 'single',
        record: matched,
        apply: async () => {
          const actorId = currentUser.value?.id;
          if (!actorId) throw new I18nError('operator_not_signed_in');
          await verifyPickingPackageForMeasuring(db, matched.id, actorId);
        },
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'measuring' }));
    }
  }

  async function matchGoodsVerify(items: BoxItem[], parsed: OcrInput): Promise<ScanMatchResult> {
    try {
      const partNo = parsed.partNo?.trim() ?? '';
      if (!partNo) return error('part_no_required');

      const item = items.find((i) => !i.verified && (i.part?.partNo || '') === partNo);
      if (!item) return { type: 'none' };

      return {
        type: 'single',
        record: item,
        apply: () => verifyShelfBoxItem(db, item.id),
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
