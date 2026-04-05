import { validateExtractedData } from '../src/validation/validator';

describe('validateExtractedData reporting model', () => {
  it('does not discard sub-1000 revenue for banks', () => {
    const r = validateExtractedData(
      { revenue_msek: 500, ebit_msek: 100, employees: 5000, ceo: 'A B' },
      'bank',
      [],
    );
    expect(r.data.revenue_msek).toBe(500);
    expect(r.warnings.some((w) => /bank revenue-equivalent/i.test(w))).toBe(true);
  });

  it('discards sub-1000 revenue for industrials', () => {
    const r = validateExtractedData(
      { revenue_msek: 500, ebit_msek: 100, employees: 5000, ceo: 'A B' },
      'industrial',
      [],
    );
    expect(r.data.revenue_msek).toBeNull();
  });

  it('keeps bank EBIT moderately above revenue-equivalent with warning', () => {
    const r = validateExtractedData(
      { revenue_msek: 10_000, ebit_msek: 12_000, employees: 5000, ceo: 'A B' },
      'bank',
      [],
    );
    expect(r.data.ebit_msek).toBe(12_000);
    expect(r.warnings.some((w) => /credit-loss|line definitions/i.test(w))).toBe(true);
  });

  it('discards bank EBIT far above revenue-equivalent', () => {
    const r = validateExtractedData(
      { revenue_msek: 10_000, ebit_msek: 20_000, employees: 5000, ceo: 'A B' },
      'bank',
      [],
    );
    expect(r.data.ebit_msek).toBeNull();
    expect(r.warnings.some((w) => /semantic mismatch/i.test(w))).toBe(true);
  });
});
