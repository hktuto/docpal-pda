import type { MeasuringPackage } from '~/services/types';

export type LabelMatchResult =
  | { kind: 'verify'; packages: MeasuringPackage[] }
  | { kind: 'already-verified'; count: number }
  | null;

/**
 * Verify/measuring label pass: a re-scanned raw label string that exactly
 * equals a package's stored `labelBarcode` verifies every package in the box
 * carrying that string (one physical label can split into portion rows).
 * Returns null when there is no label hit — the caller falls through to the
 * exact-qty match (covers legacy NULL rows and OCR-created packages).
 */
export function matchLabelPackages(
  packages: MeasuringPackage[],
  rawLabel: string | undefined,
  isDone: (pkg: MeasuringPackage) => boolean,
  targetPackageId?: string
): LabelMatchResult {
  if (!rawLabel || rawLabel.trim() === '') return null;
  const hits = packages.filter(
    (pkg) => pkg.labelBarcode === rawLabel && (!targetPackageId || pkg.id === targetPackageId)
  );
  if (hits.length === 0) return null;
  const pending = hits.filter((pkg) => !isDone(pkg));
  if (pending.length === 0) return { kind: 'already-verified', count: hits.length };
  return { kind: 'verify', packages: pending };
}
