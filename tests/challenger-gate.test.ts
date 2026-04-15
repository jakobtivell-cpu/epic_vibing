import { shouldRunLlmChallenger } from '../src/challenger/gate';

describe('shouldRunLlmChallenger', () => {
  const base = {
    hasPdfText: true,
    suspiciouslyShortPdf: false,
    confidence: 95,
    status: 'complete' as const,
    extractedData: {
      revenue_msek: 10000,
      ebit_msek: 1000,
      employees: 5000,
      ceo: 'Jane Doe',
      fiscal_year: 2025,
    },
    fiscalYear: 2025,
    companyName: 'TestCo',
    ticker: null,
    detectedCompanyType: 'industrial' as const,
    extractionNotes: [] as string[],
    forceLlm: false,
  };

  it('returns false without API key flag', () => {
    expect(shouldRunLlmChallenger(base, false)).toBe(false);
  });

  it('returns false for investment company unless forced', () => {
    expect(
      shouldRunLlmChallenger(
        { ...base, detectedCompanyType: 'investment_company', confidence: 50 },
        true,
      ),
    ).toBe(false);
  });

  it('does not run for complete rows', () => {
    expect(shouldRunLlmChallenger(base, true)).toBe(false);
  });

  it('runs for recoverable partial with missing EBIT', () => {
    expect(
      shouldRunLlmChallenger(
        {
          ...base,
          status: 'partial',
          extractedData: { ...base.extractedData!, ebit_msek: null },
        },
        true,
      ),
    ).toBe(true);
  });

  it('forceLlm skips investment skip', () => {
    expect(
      shouldRunLlmChallenger(
        { ...base, detectedCompanyType: 'investment_company', forceLlm: true },
        true,
      ),
    ).toBe(true);
  });

  it('does not run when confidence is below gate threshold', () => {
    expect(
      shouldRunLlmChallenger(
        {
          ...base,
          status: 'partial',
          confidence: 70,
          extractedData: { ...base.extractedData!, ebit_msek: null },
        },
        true,
      ),
    ).toBe(false);
  });

  it('does not run when notes indicate wrong document class', () => {
    expect(
      shouldRunLlmChallenger(
        {
          ...base,
          status: 'partial',
          extractedData: { ...base.extractedData!, ebit_msek: null },
          extractionNotes: ['No income statement / resultaträkning found in PDF'],
        },
        true,
      ),
    ).toBe(false);
  });

  it('still runs when notes only mention sustainability content', () => {
    expect(
      shouldRunLlmChallenger(
        {
          ...base,
          status: 'partial',
          extractedData: { ...base.extractedData!, ebit_msek: null },
          extractionNotes: ['Annual report includes sustainability content'],
        },
        true,
      ),
    ).toBe(true);
  });
});
