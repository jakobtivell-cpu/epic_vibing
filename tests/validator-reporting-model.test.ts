import { validateExtractedData } from '../src/validation/validator';

describe('validateExtractedData reporting model', () => {
  it('does not discard sub-1000 revenue for banks', () => {
    const r = validateExtractedData(
      { revenue_msek: 500, ebit_msek: 100, employees: 5000, ceo: 'A B', fiscal_year: null },
      'bank',
      [],
    );
    expect(r.data.revenue_msek).toBe(500);
    expect(r.warnings.some((w) => /bank revenue-equivalent/i.test(w))).toBe(true);
  });

  it('discards sub-1000 revenue for industrials', () => {
    const r = validateExtractedData(
      { revenue_msek: 500, ebit_msek: 100, employees: 5000, ceo: 'A B', fiscal_year: null },
      'industrial',
      [],
    );
    expect(r.data.revenue_msek).toBeNull();
  });

  it('keeps bank EBIT moderately above revenue-equivalent with warning', () => {
    const r = validateExtractedData(
      { revenue_msek: 10_000, ebit_msek: 12_000, employees: 5000, ceo: 'A B', fiscal_year: null },
      'bank',
      [],
    );
    expect(r.data.ebit_msek).toBe(12_000);
    expect(r.warnings.some((w) => /credit-loss|line definitions/i.test(w))).toBe(true);
  });

  it('discards bank EBIT far above revenue-equivalent', () => {
    const r = validateExtractedData(
      { revenue_msek: 10_000, ebit_msek: 20_000, employees: 5000, ceo: 'A B', fiscal_year: null },
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
      { revenue_msek: 800, ebit_msek: 3200, employees: 5000, ceo: 'A B', fiscal_year: null },
      'real_estate',
      pipelineNotes,
    );
    expect(r.data.ebit_msek).toBe(3200);
    expect(r.data.revenue_msek).toBe(800);
    expect(r.warnings.some((w) => /förvaltningsresultat.*above revenue proxy/i.test(w))).toBe(true);
  });

  it('real_estate: still discards EBIT more than 3× above revenue (clearly misaligned pick)', () => {
    const r = validateExtractedData(
      { revenue_msek: 800, ebit_msek: 3200, employees: 5000, ceo: 'A B', fiscal_year: null },
      'real_estate',
      [],
    );
    expect(r.data.ebit_msek).toBeNull();
    expect(r.warnings.some((w) => /exceeds revenue/i.test(w))).toBe(true);
  });

  it('real_estate: keeps EBIT up to 3× revenue without any pipeline note (REIT operating surplus pattern)', () => {
    const r = validateExtractedData(
      { revenue_msek: 3_548, ebit_msek: 4_139, employees: 500, ceo: 'A B', fiscal_year: null },
      'real_estate',
      [],
    );
    expect(r.data.ebit_msek).toBe(4_139);
  });

  it('industrial: discards employee counts below 100', () => {
    const r = validateExtractedData(
      { revenue_msek: 10_000, ebit_msek: 1_200, employees: 80, ceo: 'A B', fiscal_year: null },
      'industrial',
      [],
    );
    expect(r.data.employees).toBeNull();
    expect(r.warnings.some((w) => /too low .*industrial large-cap/i.test(w))).toBe(true);
  });

  it('industrial: discards EBIT at near-parity with revenue (≈100% margin is a misaligned pick)', () => {
    const r = validateExtractedData(
      { revenue_msek: 46_028, ebit_msek: 46_253, employees: 1000, ceo: 'A B', fiscal_year: null },
      'industrial',
      [],
    );
    expect(r.data.ebit_msek).toBeNull();
    expect(r.warnings.some((w) => /exceeds revenue.*discarding/i.test(w))).toBe(true);
  });

  it('industrial: discards EBIT modestly above revenue regardless of gap size (no near-parity band)', () => {
    const addLifeLike = validateExtractedData(
      { revenue_msek: 10_286, ebit_msek: 10_724, employees: 2000, ceo: 'A B', fiscal_year: 2025 },
      'industrial',
      [],
    );
    expect(addLifeLike.data.ebit_msek).toBeNull();

    const betssonLike = validateExtractedData(
      { revenue_msek: 12_443, ebit_msek: 14_130, employees: 2000, ceo: 'A B', fiscal_year: 2025 },
      'industrial',
      [],
    );
    expect(betssonLike.data.ebit_msek).toBeNull();
  });

  it('industrial: still discards EBIT far above revenue', () => {
    const r = validateExtractedData(
      { revenue_msek: 10_000, ebit_msek: 18_000, employees: 2000, ceo: 'A B', fiscal_year: null },
      'industrial',
      [],
    );
    expect(r.data.ebit_msek).toBeNull();
  });

  it('industrial: scales sub-1k revenue when headcount and EBIT margin imply ×1000 misread', () => {
    const r = validateExtractedData(
      { revenue_msek: 146, ebit_msek: 19, employees: 8496, ceo: 'A B', fiscal_year: 2025 },
      'industrial',
      [],
    );
    expect(r.data.revenue_msek).toBe(146_000);
    expect(r.warnings.some((w) => /scaled ×1000/i.test(w))).toBe(true);
  });

  it('industrial: still nulls sub-1k revenue when operating margin on the micro pair is too low (wrong line / RE)', () => {
    const r = validateExtractedData(
      { revenue_msek: 142, ebit_msek: 5, employees: 10_984, ceo: 'A B', fiscal_year: 2025 },
      'industrial',
      [],
    );
    expect(r.data.revenue_msek).toBeNull();
  });
});
