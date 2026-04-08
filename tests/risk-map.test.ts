import { buildRiskMap, buildRiskMapResponse } from '../src/risk/risk-map';
import type { PipelineResult } from '../src/types';

function mkResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    company: 'Test Company',
    ticker: 'TEST.ST',
    website: null,
    irPage: null,
    annualReportUrl: null,
    annualReportDownloaded: null,
    fiscalYear: 2025,
    extractedData: null,
    sustainability: {},
    dataSource: null,
    confidence: 95,
    status: 'complete',
    fallbackStepReached: 'none',
    detectedCompanyType: 'industrial',
    cached: false,
    extractionNotes: [],
    stages: {
      irDiscovery: { status: 'success', value: '', notes: [] },
      reportDiscovery: { status: 'success', value: null, notes: [] },
      download: { status: 'success', value: '', notes: [] },
      extraction: { status: 'success', value: null, notes: [] },
      validation: { status: 'success', value: null, notes: [] },
    },
    ...overrides,
  } as PipelineResult;
}

describe('risk-map deterministic scoring', () => {
  it('keeps stable company low risk', () => {
    const rows = buildRiskMap([
      mkResult({
        company: 'Telia',
        ticker: 'TELIA.ST',
        status: 'complete',
        confidence: 100,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].riskTier).toBe('low');
    expect(rows[0].riskScore).toBeLessThanOrEqual(34);
  });

  it('marks fragile company with high risk archetypes', () => {
    const rows = buildRiskMap([
      mkResult({
        company: 'Fragile Co',
        ticker: 'FRAG.ST',
        status: 'failed',
        fallbackStepReached: 'playwright',
        confidence: 70,
        detectedCompanyType: 'investment_company',
        extractionNotes: [
          'Quality gate rejected candidate',
          'Revenue unit guard: 1420000 -> 1420',
          'Fiscal year mismatch detected',
          'No matching company found on allabolag.se',
        ],
      }),
    ]);
    expect(rows[0].riskTier).toBe('high');
    expect(rows[0].riskScore).toBeGreaterThanOrEqual(65);
    expect(rows[0].archetypes).toEqual(
      expect.arrayContaining(['js_heavy_ir', 'layout_fragile_pdf', 'industry_semantic_risk']),
    );
  });

  it('keeps recently fixed pattern in medium tier with explicit signals', () => {
    const rows = buildRiskMap([
      mkResult({
        company: 'Recently Fixed Co',
        ticker: 'FIXD.ST',
        status: 'partial',
        fallbackStepReached: 'playwright',
        confidence: 92,
        extractionNotes: ['Revenue unit guard: 250000000 -> 250000'],
      }),
    ]);
    expect(rows[0].riskTier).toBe('medium');
    expect(rows[0].riskScore).toBeGreaterThanOrEqual(35);
    expect(rows[0].signals.join(' ')).toContain('Fallback reached playwright');
  });

  it('builds API payload shape', () => {
    const payload = buildRiskMapResponse([mkResult()], '2026-04-08T10:00:00.000Z');
    expect(payload.generatedAt).toBe('2026-04-08T10:00:00.000Z');
    expect(payload.companyCount).toBe(1);
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.results[0]).toEqual(
      expect.objectContaining({
        ticker: 'TEST.ST',
        company: 'Test Company',
        riskScore: expect.any(Number),
        riskTier: expect.any(String),
        archetypes: expect.any(Array),
        signals: expect.any(Array),
        recommendedAction: expect.any(String),
      }),
    );
  });
});
