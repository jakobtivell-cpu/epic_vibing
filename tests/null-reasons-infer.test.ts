// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  inferEbitNullReason,
  inferEmployeesNullReason,
  inferRow,
} = require('../scripts/lib/null-reasons-infer.cjs');

describe('null-reasons-infer', () => {
  it('classifies validator EBIT > revenue', () => {
    const row = {
      company: 'X',
      ticker: 'X.ST',
      status: 'partial',
      extractedData: { revenue_msek: 1000, ebit_msek: null, employees: 1, ceo: 'A B' },
      extractionNotes: ['EBIT (5000) exceeds revenue (1000) — likely extraction error, discarding EBIT'],
    };
    expect(inferEbitNullReason(row)).toBe('validator_ebit_gt_revenue');
  });

  it('classifies employee year misread', () => {
    const row = {
      company: 'Y',
      ticker: 'Y.ST',
      status: 'partial',
      extractedData: { revenue_msek: 1000, ebit_msek: 100, employees: null, ceo: 'A B' },
      extractionNotes: ['Employee count 2025 discarded — likely fiscal-year column misread'],
    };
    expect(inferEmployeesNullReason(row)).toBe('extractor_year_column_misread');
  });

  it('returns null reasons when fields present', () => {
    const row = {
      company: 'Z',
      status: 'complete',
      extractedData: { revenue_msek: 1, ebit_msek: 1, employees: 500, ceo: 'A B' },
      extractionNotes: [],
    };
    const r = inferRow(row);
    expect(r.ebit_msek).toBeNull();
    expect(r.employees).toBeNull();
  });
});
