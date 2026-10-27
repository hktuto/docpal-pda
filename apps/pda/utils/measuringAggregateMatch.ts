import { normalize, normalizeCode } from '~/utils/ocrNormalize';
import { normalizePartNo, filterScannedPartMatches } from '~/utils/text';
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
 * part identity, 2026-10-14 scanned-batch anchor): totals per part + batch
 * fields, not physical labels. A scan matches when the scanned part matches
 * the package's part OR WCL item no (space-insensitive; pkg.partNo is the
 * scanned label part when recorded, falling back to the picking item's part
 * for legacy rows), every batch field agrees wherever BOTH sides carry a
 * value, and the scanned qty fits the group's total remaining. Batch fields
 * anchor to the pick-time SCANNED values when the package carries them (same
 * physical label), falling back to the stored source snapshot for legacy rows
 * — upstream lot data and label vocabularies can differ, so the re-scan is
 * judged against what was actually scanned at pick time. The credit plan
 * walks the matching packages FIFO, taking partial credits as needed.
 * Returns 'already-done' when matching packages exist but are fully
 * credited, null when nothing matches or the qty exceeds the remaining.
 *
 * Raw-label fallback: scans created between 2026-10-05 and 2026-10-14 stored
 * only `labelBarcode` (the raw pick-time string) without the parsed batch
 * fields, and the snapshot fallback above demonstrably rejects those labels
 * (upstream WWYY ≠ label-derived WWYY). When the field comparison finds no
 * match and the caller passes the scan's raw label string, a package whose
 * stored `labelBarcode` equals it verbatim IS the same physical label —
 * accept it regardless of parsed fields.
 */
export function matchAggregatePackages(
  packages: MeasuringPackage[],
  scan: {
    partNo?: string;
    wclItemNo?: string;
    qty: number;
    dateCode?: string;
    lotCode?: string;
    coo?: string;
    cow?: string;
  },
  targetPackageId?: string,
  rawLabel?: string
): AggregateMatch | 'already-done' | null {
  const scannedKeys = [scan.partNo, scan.wclItemNo]
    .filter((v): v is string => !!v)
    .map((v) => normalizePartNo(v));
  if (scannedKeys.length === 0) return null;

  const dateCode = scanDateCode(scan);
  const lotCode = scanLotCode(scan);
  const coo = scanCoo(scan);
  const cow = scanCow(scan);

  // Part pool with WCL-item-no preference: a scanned wclItemNo (template
  // group or the single-brand derivation, e.g. ABLIC) narrows to the packages
  // carrying that WCL item no — part_no is not unique across WCL item
  // numbers, so the bare MPN alone cannot disambiguate.
  const partPool = filterScannedPartMatches(
    packages.filter((pkg) => !targetPackageId || pkg.id === targetPackageId),
    (pkg) => [pkg.partNo, pkg.wclItemNo],
    scan
  );
  const eligible = partPool.filter((pkg) => {
    // Batch anchor: the pick-time scanned value when present, else the stored
    // source snapshot (legacy rows).
    const pkgDateCode = (pkg.scannedDateCode ?? pkg.dateCode) ? normalizeCode(pkg.scannedDateCode ?? pkg.dateCode ?? "") : "";
    if (dateCode && pkgDateCode && dateCode !== pkgDateCode) return false;
    const pkgLotCode = (pkg.scannedLotCode ?? pkg.lotCode) ? normalizeCode(pkg.scannedLotCode ?? pkg.lotCode ?? "") : "";
    if (lotCode && pkgLotCode && lotCode !== pkgLotCode) return false;
    const pkgCoo = (pkg.scannedCoo ?? pkg.coo) ? normalize(pkg.scannedCoo ?? pkg.coo ?? "") : "";
    if (coo && pkgCoo && coo !== pkgCoo) return false;
    const pkgCow = (pkg.scannedCow ?? pkg.cow) ? normalize(pkg.scannedCow ?? pkg.cow ?? "") : "";
    if (cow && pkgCow && cow !== pkgCow) return false;
    return true;
  });
  if (eligible.length === 0) {
    // No package matches the parsed fields at all — try the raw-label proof
    // before giving up.
    const raw = rawLabel?.trim();
    if (raw) {
      const byRawLabel = packages.filter(
        (pkg) =>
          (!targetPackageId || pkg.id === targetPackageId) &&
          !!pkg.labelBarcode &&
          pkg.labelBarcode.trim() === raw
      );
      if (byRawLabel.length > 0) return creditPackages(byRawLabel, scan.qty);
    }
    return null;
  }

  const fieldMatch = creditPackages(eligible, scan.qty);
  if (fieldMatch !== null) return fieldMatch;
  // The parsed-field comparison matched nothing creditable (nothing eligible,
  // all fully credited is 'already-done' above, or the qty exceeds the
  // remaining) — the same physical label is provable by the raw pick-time
  // scan string when the caller provides it.
  const raw = rawLabel?.trim();
  if (raw) {
    const byRawLabel = packages.filter(
      (pkg) =>
        (!targetPackageId || pkg.id === targetPackageId) &&
        !!pkg.labelBarcode &&
        pkg.labelBarcode.trim() === raw
    );
    if (byRawLabel.length > 0) return creditPackages(byRawLabel, scan.qty);
  }
  return fieldMatch;
}

/** FIFO credit plan across the given packages (partial allowed). */
function creditPackages(
  eligible: MeasuringPackage[],
  qty: number
): AggregateMatch | 'already-done' | null {
  let left = qty;
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
  if (left > 0) return null;
  return { qty, credits };
}

// Batch fields of the scan, normalized with the same rules the old exact-qty
// pass used (empty scan side never constrains).
type ScanBatchFields = { dateCode?: string; lotCode?: string; coo?: string; cow?: string };
const scanDateCode = (s: ScanBatchFields) => (s.dateCode ? normalizeCode(s.dateCode) : '');
const scanLotCode = (s: ScanBatchFields) => (s.lotCode ? normalizeCode(s.lotCode) : '');
const scanCoo = (s: ScanBatchFields) => (s.coo ? normalize(s.coo) : '');
const scanCow = (s: ScanBatchFields) => (s.cow ? normalize(s.cow) : '');
