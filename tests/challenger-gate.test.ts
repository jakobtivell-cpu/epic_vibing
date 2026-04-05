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
    },
    fiscalYear: 2025,
    companyName: 'TestCo',
    ticker: null,
    detectedCompanyType: 'industrial' as const,
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

  it('runs when confidence is low', () => {
    expect(shouldRunLlmChallenger({ ...base, confidence: 70 }, true)).toBe(true);
  });

  it('runs when a core field is missing', () => {
    expect(
      shouldRunLlmChallenger({ ...base, extractedData: { ...base.extractedData!, ceo: null } }, true),
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
});
