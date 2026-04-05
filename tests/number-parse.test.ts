import { parseNumber } from '../src/extraction/number-parse';

describe('parseNumber', () => {
  it('parses comma-grouped English thousands', () => {
    expect(parseNumber('236,681')).toBe(236681);
    expect(parseNumber('1,234,567')).toBe(1234567);
  });

  it('parses Swedish-style spaced thousands', () => {
    expect(parseNumber('236 681')).toBe(236681);
    expect(parseNumber('1 234 567')).toBe(1234567);
  });

  it('handles accounting parentheses as negative', () => {
    expect(parseNumber('(1,234)')).toBe(-1234);
  });

  it('handles minus prefix', () => {
    expect(parseNumber('−500')).toBe(-500);
    expect(parseNumber('-42.5')).toBe(-42.5);
  });

  it('returns null for empty or non-numeric garbage', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
  });

  it('parses integers that are not comma-grouped (table fragments)', () => {
    expect(parseNumber('236681')).toBe(236681);
    expect(parseNumber('  457509  ')).toBe(457509);
  });

  it('handles Swedish decimal comma as decimal separator when last comma has ≤2 digits after', () => {
    expect(parseNumber('1234,5')).toBeCloseTo(1234.5);
  });
});
