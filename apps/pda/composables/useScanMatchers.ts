import { useAuth } from './useAuth';
import { useWarehouse } from './useWarehouse';
import { I18nError } from '~/composables/i18nError';
import type { OcrInput } from '~/utils/ocrNormalize';
import type {
  PutAwayExpectedItem,
  MeasuringPackage,
} from '~/services/types';
import { rawCode, normalizePartNo } from '~/utils/text';
import { findPutAwayTargets } from '~/utils/putAwayScan';
import { matchAggregatePackages } from '~/utils/measuringAggregateMatch';

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
      // The review context carries all visible order lines so a corrected
      // part number can match any line; one label's qty spans the matching
      // part's lines FIFO (spec 2026-10-05).
      return m.matchPutAway(ctx.receivingOrderId, ctx.putAwayItems ?? [ctx.receivingItem], parsed, ctx.shelfCode);
    case 'measuring':
      if (!ctx.packages) return m.error('missing_box_packages');
      return m.matchMeasuring(ctx.packages, ctx.targetPackageId, parsed, ctx.flow);
    default:
      return m.error('unknown_scan_task');
  }
}

interface PickingAllocationRef {
  id: string;
  qty: number;
  coo?: string | null;
  cow?: string | null;
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
  // put-away part match pool: the visible order lines the label may match —
  // the label's qty may span several same-part lines FIFO (spec
  // 2026-10-05); carrying all visible lines lets the review form's part-no
  // select re-match a corrected part (spec 2026-10-07)
  putAwayItems?: PutAwayExpectedItem[];
  // put-away selected shelf: scans commit straight onto this shelf (spec
  // 2026-10-06); unset = the scan waits in the pending list
  shelfCode?: string | null;
  // measuring (the box's packages from the consolidated task detail —
  // matching runs client-side, then verifyPackage by id)
  packages?: MeasuringPackage[];
  targetPackageId?: string;
  // measuring vs verify pass — decides which per-package flag skips a row
  // (`verified` in measuring, `verifyVerified` in verify); default 'measuring'
  flow?: 'measuring' | 'verify';
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
  // measuring/verify: the scan matched packages that are already fully
  // re-scanned (rescannedQty >= qty)
  | { type: 'already-verified'; count: number }
  | { type: 'none' }
  | { type: 'error'; message: string };

export interface ScanMatchers {
  matchPicking(allocation: PickingAllocationRef, pickingItem: PickingItemRef, parsed: OcrInput): Promise<ScanMatchResult>;
  matchPutAway(receivingOrderId: string | undefined, putAwayItems: PutAwayExpectedItem[], parsed: OcrInput, shelfCode?: string | null): Promise<ScanMatchResult>;
  matchMeasuring(packages: MeasuringPackage[], targetPackageId: string | undefined, parsed: OcrInput, flow?: 'measuring' | 'verify'): Promise<ScanMatchResult>;
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

  /**
   * Check scanned COO/COW against the target's. When the target has a value,
   * the scan must match (case-insensitive). When the target has no value, the
   * scan is not constrained. Returns an error code + params on mismatch, or
   * null when the scan is acceptable.
   */
  function checkBatchAttr(
    kind: 'coo' | 'cow',
    targetValue: string | null | undefined,
    scannedValue: string | null | undefined
  ): { code: string; params: Record<string, string> } | null {
    const target = (targetValue ?? '').trim();
    const scanned = (scannedValue ?? '').trim();
    if (!target || !scanned) return null;
    if (target.toUpperCase() === scanned.toUpperCase()) return null;
    return {
      code: kind === 'coo' ? 'coo_mismatch' : 'cow_mismatch',
      params: { scanned, expected: target },
    };
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

      // COO/COW check: when the allocation source has a value, the scan must match.
      const cooCheck = checkBatchAttr('coo', allocation.coo, parsed.coo);
      if (cooCheck) return error(cooCheck.code, cooCheck.params);
      const cowCheck = checkBatchAttr('cow', allocation.cow, parsed.cow);
      if (cowCheck) return error(cowCheck.code, cowCheck.params);

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

  async function matchPutAway(receivingOrderId: string | undefined, putAwayItems: PutAwayExpectedItem[], parsed: OcrInput, shelfCode?: string | null): Promise<ScanMatchResult> {
    try {
      const user = currentUser.value;
      if (!user?.id) return error('operator_not_signed_in');
      if (!receivingOrderId) return error('missing_receiving_order_id');

      const scannedKeys = [parsed.partNo, parsed.wclItemNo]
        .filter((v): v is string => !!v)
        .map((v) => normalizePartNo(v));
      if (scannedKeys.length === 0) return { type: 'none' };
      // Same-part group: the label matches when ANY member line's part keys
      // match; the qty may span several lines, split FIFO per line.
      const items = putAwayItems.filter((item) =>
        [item.partNo, item.wclItemNo]
          .filter((v): v is string => !!v)
          .map((v) => normalizePartNo(v))
          .some((k) => scannedKeys.includes(k))
      );
      if (items.length === 0) return error('scanned_part_does_not_match_item');

      // COO/COW check: when the receiving item has a value, the scan must match.
      for (const item of items) {
        const cooCheck = checkBatchAttr('coo', item.coo, parsed.coo);
        if (cooCheck) return error(cooCheck.code, cooCheck.params);
        const cowCheck = checkBatchAttr('cow', item.cow, parsed.cow);
        if (cowCheck) return error(cowCheck.code, cowCheck.params);
      }

      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');
      const portions = findPutAwayTargets(items, String(parsed.partNo ?? ''), qty, parsed.wclItemNo);
      if (!portions) return error('quantity_exceeds_available');

      const dateCode = rawCode(parsed.dateCode);
      const lotCode = rawCode(parsed.lotCode);
      const coo = rawCode(parsed.coo);
      const cow = rawCode(parsed.cow);

      return {
        type: 'single',
        record: items[0],
        apply: async () => {
          for (const portion of portions) {
            await warehouse.recordPutAwayScan(
              receivingOrderId,
              portion.item.id,
              portion.qty,
              dateCode,
              lotCode,
              coo,
              cow,
              shelfCode ?? null
            );
          }
        },
      };
    } catch (e: any) {
      return e instanceof I18nError ? error(e) : error(new I18nError('unknown_match_failed', { task: 'put-away' }));
    }
  }

  // Client-side aggregate match against the box's packages (2026-10-03
  // design): totals per part + batch fields, not physical labels — the scan
  // qty is credited FIFO across the matching packages (partial allowed).
  // Apply = verifyPackage per credit.
  async function matchMeasuring(packages: MeasuringPackage[], targetPackageId: string | undefined, parsed: OcrInput, flow: 'measuring' | 'verify' = 'measuring'): Promise<ScanMatchResult> {
    const user = currentUser.value;
    if (!user?.id) return error('operator_not_signed_in');

    try {
      const qty = typeof parsed.qty === 'number' ? parsed.qty : Number(parsed.qty);
      if (!Number.isInteger(qty) || qty <= 0) return error('qty_must_be_positive_integer');

      const matched = matchAggregatePackages(
        packages,
        {
          partNo: parsed.partNo,
          wclItemNo: parsed.wclItemNo,
          qty,
          dateCode: parsed.dateCode ? String(parsed.dateCode) : undefined,
          lotCode: parsed.lotCode ? String(parsed.lotCode) : undefined,
          coo: parsed.coo ? String(parsed.coo) : undefined,
          cow: parsed.cow ? String(parsed.cow) : undefined,
        },
        targetPackageId
      );
      if (matched === 'already-done') {
        const count = packages.filter((pkg) => !targetPackageId || pkg.id === targetPackageId).length;
        return { type: 'already-verified', count };
      }
      if (!matched) {
        // A scan with no part at all parses to nothing — keep the old
        // part_no_required error for that case.
        if (!parsed.partNo && !parsed.wclItemNo) return error('part_no_required');
        return { type: 'none' };
      }

      return {
        type: 'single',
        record: matched,
        apply: async () => {
          for (const credit of matched.credits) {
            await warehouse.verifyPackage(credit.packageId, credit.qty);
          }
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
