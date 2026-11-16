import { describe, it, expect } from 'vitest';
import { formatCompactQty } from './formatNumber';

describe('formatCompactQty', () => {
  it('passes small numbers through untouched', () => {
    expect(formatCompactQty(0)).toBe('0');
    expect(formatCompactQty(999)).toBe('999');
    expect(formatCompactQty(-250)).toBe('-250');
  });

  it('formats thousands with k', () => {
    expect(formatCompactQty(1000)).toBe('1k');
    expect(formatCompactQty(60000)).toBe('60k');
    expect(formatCompactQty(1234)).toBe('1.234k');
  });

  it('formats millions with M, 3 decimals max', () => {
    expect(formatCompactQty(1_000_000)).toBe('1M');
    expect(formatCompactQty(1_400_000)).toBe('1.4M');
    expect(formatCompactQty(1_180_000)).toBe('1.18M');
    expect(formatCompactQty(1_184_500)).toBe('1.185M');
    expect(formatCompactQty(1_200_000)).toBe('1.2M');
  });

  it('formats billions with B', () => {
    expect(formatCompactQty(2_000_000_000)).toBe('2B');
    expect(formatCompactQty(2_500_000_000)).toBe('2.5B');
  });
});
