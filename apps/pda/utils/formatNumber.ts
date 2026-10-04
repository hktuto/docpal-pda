/** Compact quantity display: 950 → "950", 60000 → "60k", 1_400_000 → "1.4M",
 *  2_000_000_000 → "2B". One decimal max, trailing ".0" dropped. */
export function formatCompactQty(n: number): string {
  const units: [number, string][] = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"],
  ];
  for (const [divisor, suffix] of units) {
    if (Math.abs(n) >= divisor) {
      const v = n / divisor;
      const rounded = Math.round(v * 10) / 10;
      return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded}${suffix}`;
    }
  }
  return String(n);
}
