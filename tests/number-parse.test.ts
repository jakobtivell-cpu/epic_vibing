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
});
