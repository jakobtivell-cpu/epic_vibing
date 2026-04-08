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

  it('real_estate: keeps EBIT above revenue when pipeline notes show förvaltningsresultat proxy', () => {
    const pipelineNotes = [
      'EBIT estimated from förvaltningsresultat — real estate reporting, excludes fair value changes and is the primary operating metric for this company type.',
    ];
    const r = validateExtractedData(
      { revenue_msek: 800, ebit_msek: 3200, employees: 5000, ceo: 'A B' },
      'real_estate',
      pipelineNotes,
    );
    expect(r.data.ebit_msek).toBe(3200);
    expect(r.data.revenue_msek).toBe(800);
    expect(r.warnings.some((w) => /förvaltningsresultat.*above revenue proxy/i.test(w))).toBe(true);
  });

  it('real_estate: still discards EBIT above revenue when EBIT proxy is not förvaltningsresultat', () => {
    const pipelineNotes = [
      'EBIT estimated from driftnetto — real estate reporting, excludes fair value changes',
    ];
    const r = validateExtractedData(
      { revenue_msek: 800, ebit_msek: 3200, employees: 5000, ceo: 'A B' },
      'real_estate',
      pipelineNotes,
    );
    expect(r.data.ebit_msek).toBeNull();
    expect(r.warnings.some((w) => /exceeds revenue/i.test(w))).toBe(true);
  });
});
