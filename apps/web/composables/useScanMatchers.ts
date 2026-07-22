import { normalize, normalizeCode } from './useMockOcr';
import { useAuth } from './useAuth';
import { useWarehouse } from './useWarehouse';
import { I18nError } from '~/composables/i18nError';
import type { OcrInput } from './useMockOcr';
import type {
  PutAwayExpectedItem,
  MeasuringPackage,
} from '~/services/types';
import { rawCode } from '~/utils/text';

export type ScanTask = 'picking' | 'put-away' | 'measuring';

export async function runScanMatcher(
  ctx: ScanTaskContext,
  parsed: OcrInput,
  matchers: ScanMatchers
): Promise<ScanMatchResult> {
  const m = matchers;
  switch (ctx.task) {
    case 'picking':
      if (!ctx.allocation || !ctx.pickingItem) return m.error('missing_allocation');
      return m.matchPicking(ctx.allocation, ctx.pickingItem, parsed);
    case 'put-away':
      if (!ctx.receivingItem) return m.error('missing_receiving_item');
      return m.matchPutAway(ctx.receivingOrderId, ctx.receivingItem, parsed, ctx.shelfBoxId);
    case 'measuring':
      if (!ctx.packages) return m.error('missing_box_packages');
      return m.matchMeasuring(ctx.packages, ctx.targetPackageId, parsed);
    default:
      return m.error('unknown_scan_task');
  }
}

interface PickingAllocationRef {
  id: string;
  qty: number;
}

interface PickingItemRef {
  id: string;
  partNo: string;
}

export interface ScanTaskContext {
  task: ScanTask;
  targets?: string[];
  supplierCode?: string;
  // picking (the page pre-selects the allocation row; the parent item id is
  // needed because the nested DTO does not embed it on the allocation)
  allocation?: PickingAllocationRef;
  pickingItem?: PickingItemRef;
  // put-away
  receivingOrderId?: string;
  receivingItem?: PutAwayExpectedItem;
  // put-away active box: scans are assigned straight into this open shelf box
  shelfBoxId?: string | null;
  // measuring (the box's packages from the consolidated task detail —
  // matching runs client-side, then verifyPackage by id)
  packages?: MeasuringPackage[];
  targetPackageId?: string;
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
  matchPicking(allocation: PickingAllocationRef, pickingItem: PickingItemRef, parsed: OcrInput): Promise<ScanMatchResult>;
  matchPutAway(receivingOrderId: string | undefined, receivingItem: PutAwayExpectedItem, parsed: OcrInput, shelfBoxId?: string | null): Promise<ScanMatchResult>;
  matchMeasuring(packages: MeasuringPackage[], targetPackageId: string | undefined, parsed: OcrInput): Promise<ScanMatchResult>;
  error(err: I18nError): ScanMatchResult;
  error(code: string, params?: Record<string, unknown>): ScanMatchResult;
}

export function useScanMatchers(): ScanMatchers {
  const warehouse = useWarehouse();
  const { currentUser } = useAuth();
  const { t } = useI18n();

  function error(arg: I18nError | string, params?: Record<string, unknown>): ScanMatchResult {
    if (arg instanceof I18nError) {
      return { type: 'error', message: t(`errors.${arg.code}`, (arg.params ?? {}) as Record<string, unknown>) };
    }
    return { type: 'error', message: t(`errors.${arg}`, params ?? {}) };
  }

  async function matchPicking(allocation: PickingAllocationRef, pickingItem: PickingItemRef, parsed: OcrInput): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('operator_not_signed_in');

      const scannedPartNo = normalize(parsed.partNo ?? '');
      const expectedPartNo = normalize(pickingItem.partNo ?? '');
      if (!scannedPartNo) return { type: 'none' };
      if (scannedPartNo !== expectedPartNo) return error('scanned_part_does_not_match_allocation');

      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');
      if (!allocation?.qty) return error('invalid_allocation');
      if (qty > allocation.qty) return error('qty_exceeds_allocated');

      return {
        type: 'single',
        record: allocation,
        apply: async () => {
          // The one canonical scan-to-pick endpoint covers every allocation
          // source; the label's batch fields ride along as overrides.
          await warehouse.scanPickingItem(pickingItem.id, {
            allocationId: allocation.id,
            qty,
            dateCode: rawCode(parsed.dateCode),
            lotCode: rawCode(parsed.lotCode),
            coo: rawCode(parsed.coo),
            cow: rawCode(parsed.cow),
          });
        },
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'picking' }));
    }
  }

  async function matchPutAway(receivingOrderId: string | undefined, receivingItem: PutAwayExpectedItem, parsed: OcrInput, shelfBoxId?: string | null): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('operator_not_signed_in');
      if (!receivingOrderId) return error('missing_receiving_order_id');

      const scannedPartNo = normalize(parsed.partNo ?? '');
      const expectedPartNo = normalize(receivingItem.partNo ?? '');
      if (!scannedPartNo) return { type: 'none' };
      if (scannedPartNo !== expectedPartNo) return error('scanned_part_does_not_match_item');

      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');
      if (!receivingItem?.id) return error('invalid_receiving_item');
      if (qty > (receivingItem.remainingQty ?? 0)) return error('quantity_exceeds_available');

      const dateCode = rawCode(parsed.dateCode);
      const lotCode = rawCode(parsed.lotCode);
      const coo = rawCode(parsed.coo);
      const cow = rawCode(parsed.cow);

      return {
        type: 'single',
        record: receivingItem,
        apply: async () => {
          await warehouse.recordPutAwayScan(
            receivingOrderId,
            receivingItem.id,
            qty,
            dateCode,
            lotCode,
            coo,
            cow,
            shelfBoxId ?? null
          );
        },
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'put-away' }));
    }
  }

  // Client-side match against the box's packages (consolidated measuring
  // detail): part must agree, the label's batch fields constrain only when
  // both sides carry a value, and qty must be exact. Apply = verifyPackage.
  async function matchMeasuring(packages: MeasuringPackage[], targetPackageId: string | undefined, parsed: OcrInput): Promise<ScanMatchResult> {
    const user = currentUser.value;
    if (!user?.id) return error('operator_not_signed_in');

    try {
      const partNo = normalize(parsed.partNo ?? '');
      if (!partNo) return error('part_no_required');
      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');

      const dateCode = parsed.dateCode ? normalizeCode(parsed.dateCode) : '';
      const lotCode = parsed.lotCode ? normalizeCode(parsed.lotCode) : '';
      const coo = parsed.coo ? normalize(parsed.coo) : '';
      const cow = parsed.cow ? normalize(parsed.cow) : '';

      const matched = packages.find((pkg) => {
        if (pkg.verified) return false;
        if (targetPackageId && pkg.id !== targetPackageId) return false;
        if (normalize(pkg.partNo) !== partNo) return false;
        const pkgDateCode = pkg.dateCode ? normalizeCode(pkg.dateCode) : '';
        if (dateCode && pkgDateCode && dateCode !== pkgDateCode) return false;
        const pkgLotCode = pkg.lotCode ? normalizeCode(pkg.lotCode) : '';
        if (lotCode && pkgLotCode && lotCode !== pkgLotCode) return false;
        const pkgCoo = pkg.coo ? normalize(pkg.coo) : '';
        if (coo && pkgCoo && coo !== pkgCoo) return false;
        const pkgCow = pkg.cow ? normalize(pkg.cow) : '';
        if (cow && pkgCow && cow !== pkgCow) return false;
        return pkg.qty === qty;
      });

      if (!matched) return { type: 'none' };

      return {
        type: 'single',
        record: matched,
        apply: async () => {
          await warehouse.verifyPackage(matched.id);
        },
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'measuring' }));
    }
  }

  return {
    matchPicking,
    matchPutAway,
    matchMeasuring,
    error,
  };
}
