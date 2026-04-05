import {
  applyRevenueMegascaleMsekGuard,
  isFusedYearIntegerCorruption,
} from '../src/extraction/number-guards';

describe('number-guards', () => {
  describe('isFusedYearIntegerCorruption', () => {
    it('flags fused 8-digit year pairs in large integers', () => {
      expect(isFusedYearIntegerCorruption(20252024)).toBe(true);
      expect(isFusedYearIntegerCorruption(20252024000)).toBe(true);
    });

    it('does not flag normal Large Cap revenues', () => {
      expect(isFusedYearIntegerCorruption(236_681)).toBe(false);
      expect(isFusedYearIntegerCorruption(1_382_378)).toBe(false);
    });
  });

  describe('applyRevenueMegascaleMsekGuard', () => {
    it('divides once when MSEK is implausibly above 1e6 (tkr-as-MSEK inflation)', () => {
      const { revenue, adjusted } = applyRevenueMegascaleMsekGuard(1_382_378);
      expect(adjusted).toBe(true);
      expect(revenue).toBe(1382);
    });

    it('leaves values at or below 1_000_000 unchanged', () => {
      expect(applyRevenueMegascaleMsekGuard(457_509)).toEqual({
        revenue: 457_509,
        adjusted: false,
      });
    });
  });
});
