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
    expect(formatCompactQty(1234)).toBe('1.2k');
  });

  it('formats millions with M', () => {
    expect(formatCompactQty(1_000_000)).toBe('1M');
    expect(formatCompactQty(1_400_000)).toBe('1.4M');
  });

  it('formats billions with B', () => {
    expect(formatCompactQty(2_000_000_000)).toBe('2B');
    expect(formatCompactQty(2_500_000_000)).toBe('2.5B');
  });
});
