import { repairEbitBeforeValidation } from '../src/extraction/ebit-repair';

const baseCtx = {
  pdfText: null as string | null,
  fiscalYear: 2024 as number | null,
  reportingModelHint: 'unspecified' as const,
  fieldExtraction: null,
};

describe('repairEbitBeforeValidation', () => {
  it('rescales industrial EBIT when far above revenue', () => {
    const { data, notes } = repairEbitBeforeValidation(
      {
        revenue_msek: 50_000,
        ebit_msek: 50_000_000,
        employees: 1000,
        ceo: 'A B',
        fiscal_year: null,
      },
      'industrial',
      [],
      baseCtx,
    );
    expect(data.ebit_msek).toBe(50_000);
    expect(notes.some((n) => n.includes('÷1000'))).toBe(true);
  });

  it('skips repair for investment companies', () => {
    const { data, notes } = repairEbitBeforeValidation(
      { revenue_msek: 1000, ebit_msek: 2_000_000, employees: 50, ceo: 'A B', fiscal_year: null },
      'investment_company',
      [],
      baseCtx,
    );
    expect(data.ebit_msek).toBe(2_000_000);
    expect(notes).toHaveLength(0);
  });

  it('applies KSEK hint from provenance before generic rescale', () => {
    const { data, notes } = repairEbitBeforeValidation(
      {
        revenue_msek: 10_000,
        ebit_msek: 8_000_000,
        employees: 500,
        ceo: 'A B',
        fiscal_year: null,
      },
      'industrial',
      [],
      {
        ...baseCtx,
        fieldExtraction: {
          data: {
            revenue_msek: null,
            ebit_msek: null,
            employees: null,
            ceo: null,
            fiscal_year: null,
          },
          fiscalYear: null,
          detectedCompanyType: 'industrial',
          provenance: {
            revenue: null,
            ebit: {
              matchedLabel: 'ebit',
              rawSnippet: '8 000 tkr',
              lineIndex: 1,
              context: 'income-statement',
            },
            employees: null,
            ceo: null,
          },
          notes: [],
        },
      },
    );
    expect(data.ebit_msek).toBe(8000);
    expect(notes.some((n) => n.includes('÷1000') && n.includes('KSEK'))).toBe(true);
  });
});
