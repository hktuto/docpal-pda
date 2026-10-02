import { normalize, normalizeCode } from './useMockOcr';
import { useAuth } from './useAuth';
import { useWarehouse } from './useWarehouse';
import { I18nError } from '~/composables/i18nError';
import type { OcrInput } from './useMockOcr';
import type {
  PutAwayExpectedItem,
  MeasuringPackage,
} from '~/services/types';
import { rawCode, normalizePartNo } from '~/utils/text';
import { matchLabelPackages } from '~/utils/measuringLabelMatch';

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
      return m.matchMeasuring(ctx.packages, ctx.targetPackageId, parsed, ctx.flow, ctx.rawLabel);
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
  // measuring vs verify pass — decides which per-package flag skips a row
  // (`verified` in measuring, `verifyVerified` in verify); default 'measuring'
  flow?: 'measuring' | 'verify';
  // measuring/verify: raw hardware-scan string, used by the label pass in
  // matchMeasuring (camera/OCR scans have no raw string → qty match only)
  rawLabel?: string;
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
  // measuring/verify label pass: one raw label matched several portion rows —
  // apply verifies them all (verifyPackage per package)
  | { type: 'label'; packages: MeasuringPackage[]; apply: () => Promise<void> }
  // measuring/verify label pass: every package carrying the label is verified
  | { type: 'already-verified'; count: number }
  | { type: 'none' }
  | { type: 'error'; message: string };

export interface ScanMatchers {
  matchPicking(allocation: PickingAllocationRef, pickingItem: PickingItemRef, parsed: OcrInput): Promise<ScanMatchResult>;
  matchPutAway(receivingOrderId: string | undefined, receivingItem: PutAwayExpectedItem, parsed: OcrInput, shelfBoxId?: string | null): Promise<ScanMatchResult>;
  matchMeasuring(packages: MeasuringPackage[], targetPackageId: string | undefined, parsed: OcrInput, flow?: 'measuring' | 'verify', rawLabel?: string): Promise<ScanMatchResult>;
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

      // Space-insensitive compare; the label's WCL item no is accepted too.
      const scannedKeys = [parsed.partNo, parsed.wclItemNo]
        .filter((v): v is string => !!v)
        .map((v) => normalizePartNo(v));
      if (scannedKeys.length === 0) return { type: 'none' };
      const expectedPartNo = normalizePartNo(pickingItem.partNo ?? '');
      if (!scannedKeys.includes(expectedPartNo)) return error('scanned_part_does_not_match_allocation');

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

      const scannedKeys = [parsed.partNo, parsed.wclItemNo]
        .filter((v): v is string => !!v)
        .map((v) => normalizePartNo(v));
      if (scannedKeys.length === 0) return { type: 'none' };
      const itemKeys = [receivingItem.partNo, receivingItem.wclItemNo]
        .filter((v): v is string => !!v)
        .map((v) => normalizePartNo(v));
      if (!itemKeys.some((k) => scannedKeys.includes(k))) return error('scanned_part_does_not_match_item');

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
  // detail): a raw-scan label pass first (exact labelBarcode equality verifies
  // every portion of the label at once), then the qty pass — part must agree,
  // the label's batch fields constrain only when both sides carry a value,
  // and qty must be exact. Apply = verifyPackage.
  async function matchMeasuring(packages: MeasuringPackage[], targetPackageId: string | undefined, parsed: OcrInput, flow: 'measuring' | 'verify' = 'measuring', rawLabel?: string): Promise<ScanMatchResult> {
    const user = currentUser.value;
    if (!user?.id) return error('operator_not_signed_in');

    try {
      // The verify pass re-scans against the verify-specific flag; the
      // measuring pass uses the shared `verified` flag.
      const alreadyDone = (pkg: MeasuringPackage) =>
        flow === 'verify' ? pkg.verifyVerified : pkg.verified;

      // Label pass first: a hardware re-scan whose raw string exactly equals
      // a stored labelBarcode verifies every portion of that physical label
      // in one shot (portions can never qty-match individually). No label hit
      // falls through to the exact-qty match below (legacy NULL rows, OCR).
      const labelMatch = matchLabelPackages(packages, rawLabel, alreadyDone, targetPackageId);
      if (labelMatch?.kind === 'already-verified') {
        return { type: 'already-verified', count: labelMatch.count };
      }
      if (labelMatch?.kind === 'verify') {
        const hits = labelMatch.packages;
        return {
          type: 'label',
          packages: hits,
          apply: async () => {
            for (const pkg of hits) {
              await warehouse.verifyPackage(pkg.id);
            }
          },
        };
      }

      const scannedKeys = [parsed.partNo, parsed.wclItemNo]
        .filter((v): v is string => !!v)
        .map((v) => normalizePartNo(v));
      if (scannedKeys.length === 0) return error('part_no_required');
      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');

      const dateCode = parsed.dateCode ? normalizeCode(parsed.dateCode) : '';
      const lotCode = parsed.lotCode ? normalizeCode(parsed.lotCode) : '';
      const coo = parsed.coo ? normalize(parsed.coo) : '';
      const cow = parsed.cow ? normalize(parsed.cow) : '';

      const matched = packages.find((pkg) => {
        if (alreadyDone(pkg)) return false;
        if (targetPackageId && pkg.id !== targetPackageId) return false;
        if (!scannedKeys.includes(normalizePartNo(pkg.partNo ?? ''))) return false;
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
