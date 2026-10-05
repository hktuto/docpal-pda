import { normalize, normalizeCode } from '~/utils/ocrNormalize';
import { normalizePartNo } from '~/utils/text';
import type { MeasuringPackage } from '~/services/types';

export interface AggregateCredit {
  packageId: string;
  qty: number;
}

export interface AggregateMatch {
  qty: number;
  /** FIFO credit plan across the group's packages (partial allowed). */
  credits: AggregateCredit[];
}

/** Remaining unscanned qty of a package (mode-agnostic counter). */
export function packageRemaining(pkg: MeasuringPackage): number {
  return Math.max(0, pkg.qty - (pkg.rescannedQty ?? 0));
}

/**
 * Aggregate verify/measuring match (2026-10-03 design, 2026-10-05 scan-truth
 * part identity): totals per part + batch fields, not physical labels. A scan
 * matches when the scanned part matches the package's part OR WCL item no
 * (space-insensitive; pkg.partNo is the scanned label part when recorded,
 * falling back to the picking item's part for legacy rows), every batch
 * field agrees wherever BOTH sides carry a value, and the scanned qty fits
 * the group's total remaining. The credit plan walks the matching packages
 * FIFO, taking partial credits as needed.
 * Returns 'already-done' when matching packages exist but are fully
 * credited, null when nothing matches or the qty exceeds the remaining.
 */
export function matchAggregatePackages(
  packages: MeasuringPackage[],
  scan: { partNo?: string; wclItemNo?: string; qty: number },
  targetPackageId?: string
): AggregateMatch | 'already-done' | null {
  const scannedKeys = [scan.partNo, scan.wclItemNo]
    .filter((v): v is string => !!v)
    .map((v) => normalizePartNo(v));
  if (scannedKeys.length === 0) return null;

  const dateCode = scanDateCode(scan);
  const lotCode = scanLotCode(scan);
  const coo = scanCoo(scan);
  const cow = scanCow(scan);

  const eligible = packages.filter((pkg) => {
    if (targetPackageId && pkg.id !== targetPackageId) return false;
    const pkgKeys = [pkg.partNo, pkg.wclItemNo]
      .filter((v): v is string => !!v)
      .map((v) => normalizePartNo(v));
    if (!scannedKeys.some((k) => pkgKeys.includes(k))) return false;
    const pkgDateCode = pkg.dateCode ? normalizeCode(pkg.dateCode) : '';
    if (dateCode && pkgDateCode && dateCode !== pkgDateCode) return false;
    const pkgLotCode = pkg.lotCode ? normalizeCode(pkg.lotCode) : '';
    if (lotCode && pkgLotCode && lotCode !== pkgLotCode) return false;
    const pkgCoo = pkg.coo ? normalize(pkg.coo) : '';
    if (coo && pkgCoo && coo !== pkgCoo) return false;
    const pkgCow = pkg.cow ? normalize(pkg.cow) : '';
    if (cow && pkgCow && cow !== pkgCow) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  let left = scan.qty;
  const credits: AggregateCredit[] = [];
  for (const pkg of eligible) {
    if (left <= 0) break;
    const take = Math.min(left, packageRemaining(pkg));
    if (take > 0) {
      credits.push({ packageId: pkg.id, qty: take });
      left -= take;
    }
  }
  if (credits.length === 0) return 'already-done';
  if (left > 0) return null; // scanned qty exceeds the group's remaining
  return { qty: scan.qty, credits };
}

// Batch fields of the scan, normalized with the same rules the old exact-qty
// pass used (empty scan side never constrains).
type ScanBatchFields = { dateCode?: string; lotCode?: string; coo?: string; cow?: string };
const scanDateCode = (s: ScanBatchFields) => (s.dateCode ? normalizeCode(s.dateCode) : '');
const scanLotCode = (s: ScanBatchFields) => (s.lotCode ? normalizeCode(s.lotCode) : '');
const scanCoo = (s: ScanBatchFields) => (s.coo ? normalize(s.coo) : '');
const scanCow = (s: ScanBatchFields) => (s.cow ? normalize(s.cow) : '');
