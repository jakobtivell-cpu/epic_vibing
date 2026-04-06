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
    it('does not divide industrial revenue between 1M and 3M MSEK (avoid mangling wrong table picks)', () => {
      expect(applyRevenueMegascaleMsekGuard(1_382_378, 'industrial')).toEqual({
        revenue: 1_382_378,
        adjusted: false,
      });
    });

    it('divides once when industrial MSEK is above 3M (tkr-as-MSEK inflation)', () => {
      const { revenue, adjusted } = applyRevenueMegascaleMsekGuard(5_000_000, 'industrial');
      expect(adjusted).toBe(true);
      expect(revenue).toBe(5000);
    });

    it('leaves values at or below threshold unchanged', () => {
      expect(applyRevenueMegascaleMsekGuard(457_509)).toEqual({
        revenue: 457_509,
        adjusted: false,
      });
    });

    it('uses a higher threshold for banks', () => {
      expect(applyRevenueMegascaleMsekGuard(5_000_000, 'bank')).toEqual({
        revenue: 5_000_000,
        adjusted: false,
      });
      expect(applyRevenueMegascaleMsekGuard(100_000_000, 'bank').adjusted).toBe(true);
    });
  });
});
