import type { MeasuringPackage } from '~/services/types';

// Verify/measuring display split (spec 2026-10-30): packages of labeled
// orders (labelMode) follow the per-package label-verify flow; the rest are
// aggregate-mode and render as one row per item + batch combo with summed
// totals instead of per-package rows.

/** One aggregate-mode row: a group of packages sharing part identity and the
 *  same batch anchors (the pick-time scanned values when recorded, else the
 *  stored source snapshot — same anchor rule as the aggregate matcher). */
export interface VerifyAggregateGroup {
  key: string;
  partNo: string;
  wclItemNo: string | null;
  dateCode: string | null;
  coo: string | null;
  cow: string | null;
  totalQty: number;
  rescannedQty: number;
  packages: MeasuringPackage[];
}

export function isLabelModePackage(pkg: MeasuringPackage): boolean {
  return pkg.labelMode === true;
}

/** Batch anchor of a package: scanned pick-time value ?? stored snapshot. */
function anchor(value: string | null | undefined, scanned: string | null | undefined): string {
  return (scanned ?? value ?? '').trim();
}

export function aggregateGroupKey(pkg: MeasuringPackage): string {
  return [
    pkg.partNo ?? '',
    pkg.wclItemNo ?? '',
    anchor(pkg.dateCode, pkg.scannedDateCode),
    anchor(pkg.coo, pkg.scannedCoo),
    anchor(pkg.cow, pkg.scannedCow),
  ].join('|');
}

/** Group aggregate-mode (labelMode !== true) packages per item + batch combo,
 *  summing qty and the re-scan credit. Input order is preserved (first-seen
 *  group order, package order within a group). */
export function groupAggregatePackages(packages: MeasuringPackage[]): VerifyAggregateGroup[] {
  const groups = new Map<string, VerifyAggregateGroup>();
  for (const pkg of packages) {
    if (isLabelModePackage(pkg)) continue;
    const key = aggregateGroupKey(pkg);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        partNo: pkg.partNo,
        wclItemNo: pkg.wclItemNo,
        dateCode: pkg.scannedDateCode ?? pkg.dateCode,
        coo: pkg.scannedCoo ?? pkg.coo,
        cow: pkg.scannedCow ?? pkg.cow,
        totalQty: 0,
        rescannedQty: 0,
        packages: [],
      };
      groups.set(key, group);
    }
    group.totalQty += pkg.qty;
    group.rescannedQty += pkg.rescannedQty ?? 0;
    group.packages.push(pkg);
  }
  return [...groups.values()];
}

export function groupFullyRescanned(group: VerifyAggregateGroup): boolean {
  return group.rescannedQty >= group.totalQty;
}

/** Whether the box has any label-mode work: label-scan dispatch runs before
 *  the aggregate matcher when true (spec 2026-10-30). */
export function hasLabelWork(
  packages: MeasuringPackage[],
  box: { cartonLabelRequired?: boolean; cartonLabelVerified?: boolean } | null | undefined
): boolean {
  if (packages.some(isLabelModePackage)) return true;
  return !!box?.cartonLabelRequired && !box.cartonLabelVerified;
}

export type VerifyScanDispatch<L, R> =
  | { kind: 'label'; result: L }
  | { kind: 'aggregate'; result: R };

/** Scan dispatch order (spec 2026-10-30): when the box/task has label-mode
 *  work, try the printed-label match FIRST; only a miss (null) falls through
 *  to the aggregate matcher. */
export async function dispatchVerifyScan<L, R>(
  raw: string,
  opts: {
    labelModeActive: boolean;
    scanLabel: (raw: string) => Promise<L | null>;
    aggregate: (raw: string) => Promise<R>;
  }
): Promise<VerifyScanDispatch<L, R>> {
  if (opts.labelModeActive) {
    const hit = await opts.scanLabel(raw);
    if (hit) return { kind: 'label', result: hit };
  }
  return { kind: 'aggregate', result: await opts.aggregate(raw) };
}
