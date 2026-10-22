import { describe, it, expect } from 'vitest';
import {
  compareDateCodes,
  dateToDateCode,
  parseDateCode,
  swapDateCode,
  toCanonicalDateCode,
  toLabelDateCode,
} from '../utils/dateCode';

describe('dateToDateCode', () => {
  it('emits canonical YYWW (year first)', () => {
    expect(dateToDateCode(new Date(Date.UTC(2026, 0, 1)))).toBe('2601'); // Thu, ISO week 1
    expect(dateToDateCode(new Date(Date.UTC(2026, 9, 22)))).toBe('2643');
    expect(dateToDateCode(new Date(Date.UTC(2026, 11, 31)))).toBe('2653'); // 2026 has 53 ISO weeks
    expect(dateToDateCode(new Date(Date.UTC(2027, 0, 1)))).toBe('2653'); // Fri, still ISO week 53 of 2026
  });
});

describe('swapDateCode', () => {
  it('WWYY↔YYWW pair swap', () => {
    expect(swapDateCode('3726')).toBe('2637');
    expect(swapDateCode('2637')).toBe('3726');
    expect(swapDateCode('2652')).toBe('5226');
    expect(swapDateCode(swapDateCode('3726'))).toBe('3726'); // involution
  });

  it('non-4-digit input passes through unchanged, null-safe', () => {
    expect(swapDateCode('123')).toBe('123');
    expect(swapDateCode('12345')).toBe('12345');
    expect(swapDateCode('abcd')).toBe('abcd');
    expect(swapDateCode('')).toBe('');
    expect(swapDateCode(null)).toBe(null);
    expect(swapDateCode(undefined)).toBe(null);
  });
});

describe('toCanonicalDateCode', () => {
  it('wwyy swaps, yyww is identity', () => {
    expect(toCanonicalDateCode('3726', 'wwyy')).toBe('2637');
    expect(toCanonicalDateCode('2637', 'yyww')).toBe('2637');
  });

  it('non-4-digit codes pass through, null-safe', () => {
    expect(toCanonicalDateCode('123', 'wwyy')).toBe('123');
    expect(toCanonicalDateCode('26-37', 'wwyy')).toBe('26-37');
    expect(toCanonicalDateCode(null, 'wwyy')).toBe(null);
    expect(toCanonicalDateCode(null, 'yyww')).toBe(null);
    expect(toCanonicalDateCode(undefined, 'yyww')).toBe(null);
  });
});

describe('toLabelDateCode', () => {
  it('inverse of toCanonicalDateCode (round-trips both formats)', () => {
    expect(toLabelDateCode('2637', 'wwyy')).toBe('3726');
    expect(toLabelDateCode('2637', 'yyww')).toBe('2637');
    for (const fmt of ['wwyy', 'yyww'] as const) {
      expect(toLabelDateCode(toCanonicalDateCode('3726', fmt), fmt)).toBe('3726');
      expect(toCanonicalDateCode(toLabelDateCode('2637', fmt), fmt)).toBe('2637');
    }
  });
});

describe('parseDateCode', () => {
  it('parses canonical YYWW (year = first pair, week = second pair)', () => {
    expect(parseDateCode('2637')).toEqual({ year: 2026, week: 37 });
    expect(parseDateCode('2601')).toEqual({ year: 2026, week: 1 });
    expect(parseDateCode('2552')).toEqual({ year: 2025, week: 52 });
  });

  it('rejects invalid input', () => {
    expect(parseDateCode('')).toBeNull();
    expect(parseDateCode(null)).toBeNull();
    expect(parseDateCode('26372')).toBeNull();
    expect(parseDateCode('263')).toBeNull();
    expect(parseDateCode('2600')).toBeNull(); // week 00 invalid
    expect(parseDateCode('2654')).toBeNull(); // week 54 invalid
    expect(parseDateCode('0326')).toBeNull(); // year 2003 implausible — a WWYY label (week 03 of 2026), not YYWW; skip rather than mis-compare
    expect(parseDateCode('26-37')).toBeNull();
    expect(parseDateCode('ABCD')).toBeNull();
  });
});

describe('compareDateCodes', () => {
  it('compares year first, then week', () => {
    expect(compareDateCodes('2626', '2626')).toBe('equal');
    expect(compareDateCodes('2625', '2626')).toBe('earlier');
    expect(compareDateCodes('2627', '2626')).toBe('later');
  });

  it('orders across a year boundary chronologically', () => {
    expect(compareDateCodes('2552', '2601')).toBe('earlier'); // wk52 2025 < wk01 2026
    expect(compareDateCodes('2601', '2552')).toBe('later');
  });

  it('returns null when either side is unparseable', () => {
    expect(compareDateCodes('26-37', '2626')).toBeNull();
    expect(compareDateCodes('2626', '')).toBeNull();
    expect(compareDateCodes('', '')).toBeNull();
    // a WWYY label read as canonical YYWW: week pair 26 is fine but the
    // year pair 03 < 2015 → unparseable → do-not-reject
    expect(compareDateCodes('0326', '2626')).toBeNull();
  });
});
