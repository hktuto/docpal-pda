/** Compact quantity display: 950 → "950", 60000 → "60k", 1_400_000 → "1.4M",
 *  2_000_000_000 → "2B". Up to 3 decimals (2026-11: was 1 — 1.18M read as
 *  "1.2M" and hid a shortfall against a 1.2M requirement), trailing zeros
 *  dropped. */
export function formatCompactQty(n: number): string {
  const units: [number, string][] = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"],
  ];
  for (const [divisor, suffix] of units) {
    if (Math.abs(n) >= divisor) {
      // toFixed(3) rounds; strip trailing zeros (and a bare trailing dot).
      return `${Number(n / divisor).toFixed(3).replace(/\.?0+$/, "")}${suffix}`;
    }
  }
  return String(n);
}

/** Uppercase-suffix variant for the picking unified list (3K / 1.4M / 2B). */
export function formatCompactQtyUpper(n: number): string {
  return formatCompactQty(n).replace(/[kMB]$/, (s) => s.toUpperCase());
}
