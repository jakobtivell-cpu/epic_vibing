import { validateExtractedData } from '../src/validation/validator';

describe('validateExtractedData — implausible magnitudes', () => {
  it('discards industrial revenue above 5_000_000 MSEK', () => {
    const r = validateExtractedData(
      {
        revenue_msek: 12_000_000,
        ebit_msek: 100,
        employees: 10_000,
        ceo: 'X',
      },
      'industrial',
    );
    expect(r.data.revenue_msek).toBeNull();
    expect(r.warnings.some((w) => w.includes('implausibly high'))).toBe(true);
  });

  it('discards EBIT above industrial ceiling', () => {
    const r = validateExtractedData(
      {
        revenue_msek: 100_000,
        ebit_msek: 5_000_000,
        employees: 5000,
        ceo: 'X',
      },
      'industrial',
    );
    expect(r.data.ebit_msek).toBeNull();
    expect(r.warnings.some((w) => w.includes('implausibly large'))).toBe(true);
  });

  it('keeps real estate EBIT modestly above revenue proxy (presentation mismatch)', () => {
    const r = validateExtractedData(
      {
        revenue_msek: 8_000,
        ebit_msek: 8_500,
        employees: 500,
        ceo: 'A B',
      },
      'real_estate',
    );
    expect(r.data.ebit_msek).toBe(8_500);
    expect(r.warnings.some((w) => /real estate.*kept/i.test(w))).toBe(true);
  });
});
