import { useDb } from './useDb';
import { parseManual, normalize } from './useMockOcr';
import { useAuth } from './useAuth';
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

export async function runScanMatcher(ctx: ScanTaskContext, parsed: OcrInput): Promise<ScanMatchResult> {
  const matchers = useScanMatchers();
  switch (ctx.task) {
    case 'receiving':
      if (!ctx.receivingOrderId) return { type: 'error', message: 'Missing receiving order ID' };
      return matchers.matchReceiving(ctx.receivingOrderId, ctx.pickingItemId, parsed);
    case 'picking':
      if (!ctx.allocation) return { type: 'error', message: 'Missing allocation' };
      return matchers.matchPicking(ctx.allocation, parsed);
    case 'put-away':
      if (!ctx.receivingItem) return { type: 'error', message: 'Missing receiving item' };
      if (!ctx.targetBoxId) return { type: 'error', message: 'Missing target box' };
      return matchers.matchPutAway(ctx.receivingItem, ctx.targetBoxId, parsed);
    case 'measuring':
      if (!ctx.boxId) return { type: 'error', message: 'Missing box ID' };
      return matchers.matchMeasuring(ctx.boxId, ctx.targetPackageId, parsed);
    case 'goods-verify':
      if (!ctx.items) return { type: 'error', message: 'Missing box items' };
      return matchers.matchGoodsVerify(ctx.items, parsed);
    default:
      return { type: 'error', message: 'Unknown scan task' };
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
}

export function useScanMatchers(): ScanMatchers {
  const db = useDb();
  const { currentUser } = useAuth();

  function error(message: string): ScanMatchResult {
    return { type: 'error', message };
  }

  async function matchReceiving(
    receivingOrderId: string,
    pickingItemId: string | undefined,
    parsed: OcrInput
  ): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('Operator not signed in');

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
        if (!actorId) throw new Error('Operator not signed in');
        const qty = p.qty;
        if (!Number.isInteger(qty) || qty <= 0) throw new Error('Invalid quantity to apply');
        if (qty > receiving.availableQty) throw new Error('Quantity no longer available in receiving');
        if (qty > picking.remainingQty) throw new Error('Quantity exceeds picking order need');
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
      return error(e?.message ?? 'Receiving match failed');
    }
  }

  async function matchPicking(allocation: PickingAllocation, parsed: OcrInput): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('Operator not signed in');

      const scannedPartNo = normalize(parsed.partNo ?? '');
      const expectedPartNo = normalize(allocation?.pickingItem?.part?.partNo ?? '');
      if (!scannedPartNo) return { type: 'none' };
      if (scannedPartNo !== expectedPartNo) return error('Scanned part does not match allocation');

      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('Qty must be a positive integer');
      if (!allocation?.qty) return error('Invalid allocation');
      if (qty > allocation.qty) return error('Qty exceeds allocated quantity');

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
          if (!actorId) throw new Error('Operator not signed in');
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
      return error(e?.message ?? 'Picking match failed');
    }
  }

  async function matchPutAway(receivingItem: PutAwayLot, targetBoxId: string, parsed: OcrInput): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('Operator not signed in');

      const scannedPartNo = normalize(parsed.partNo ?? '');
      const expectedPartNo = normalize(receivingItem.part_no ?? '');
      if (!scannedPartNo) return { type: 'none' };
      if (scannedPartNo !== expectedPartNo) return error('Scanned part does not match item');

      if (!targetBoxId) return error('Select an open box');
      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('Qty must be a positive integer');
      if (!receivingItem?.receiving_invoice_item_id) return error('Invalid receiving item');
      if (qty > (receivingItem.available_qty ?? 0)) return error('Quantity exceeds available quantity');

      const dateCode = rawCode(parsed.dateCode);
      const lotCode = rawCode(parsed.lotCode);
      const coo = rawCode(parsed.coo);
      const cow = rawCode(parsed.cow);

      return {
        type: 'single',
        record: receivingItem,
        apply: async () => {
          const actorId = currentUser.value?.id;
          if (!actorId) throw new Error('Operator not signed in');
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
      return error(e?.message ?? 'Put-away match failed');
    }
  }

  async function matchMeasuring(boxId: string, targetPackageId: string | undefined, parsed: OcrInput): Promise<ScanMatchResult> {
    const user = currentUser.value;
    if (!user?.id) return error('Operator not signed in');

    try {
      if (!parsed.partNo?.trim()) return error('Part No. is required');
      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('Qty must be a positive integer');

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
          if (!actorId) throw new Error('Operator not signed in');
          await verifyPickingPackageForMeasuring(db, matched.id, actorId);
        },
      };
    } catch (e: any) {
      return error(e?.message ?? 'Measuring match failed');
    }
  }

  async function matchGoodsVerify(items: BoxItem[], parsed: OcrInput): Promise<ScanMatchResult> {
    try {
      const partNo = parsed.partNo?.trim() ?? '';
      if (!partNo) return error('Part No. is required');

      const item = items.find((i) => !i.verified && (i.part?.partNo || '') === partNo);
      if (!item) return { type: 'none' };

      return {
        type: 'single',
        record: item,
        apply: () => verifyShelfBoxItem(db, item.id),
      };
    } catch (e: any) {
      return error(e?.message ?? 'Goods verify match failed');
    }
  }

  return {
    matchReceiving,
    matchPicking,
    matchPutAway,
    matchMeasuring,
    matchGoodsVerify,
  };
}
