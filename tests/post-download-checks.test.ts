import type { EntityProfile } from '../src/entity/entity-profile';
import {
  buildEntityCheckTerms,
  crossValidateFiscalYear,
  verifyAnnualReportContent,
  verifyEntityInPdf,
} from '../src/validation/post-download-checks';

const hmLikeProfile = (): EntityProfile => ({
  displayName: 'H&M',
  legalName: 'H & M Hennes & Mauritz AB (publ)',
  ticker: 'HM B',
  orgNumber: null,
  searchAnchor: 'H & M Hennes & Mauritz AB (publ)',
  canonicalNames: [],
  aliasNamesLowTrust: [],
  distinctiveTokens: ['hennes', 'mauritz'],
  ambiguityLevel: 'high',
  reportingModelHint: 'unspecified',
  hostnameRejectRules: [],
  seedCandidateDomains: [],
  seedIrPage: null,
  knownAliases: [],
});

describe('post-download entity verification', () => {
  it('includes ampersand brand fragments (H&M) as standalone needles', () => {
    const terms = buildEntityCheckTerms(hmLikeProfile());
    expect(terms.some((t) => t.needle === 'H&M')).toBe(true);
  });

  it('accepts PDF front matter that only says H&M Group (high ambiguity, no Hennes/Mauritz)', () => {
    const text = `${'H&M Group — annual report 2025\n'.repeat(400)}`;
    const r = verifyEntityInPdf(text, hmLikeProfile());
    expect(r.passed).toBe(true);
    expect(r.matchedTerm).toContain('H&M');
  });

  it('accepts strong legal anchor in wider 12k window', () => {
    const entity = hmLikeProfile();
    const text =
      `${'filler line without company identity\n'.repeat(250)}` +
      'H & M Hennes & Mauritz AB (publ)\nAnnual report 2025\n';
    const r = verifyEntityInPdf(text, entity);
    expect(r.passed).toBe(true);
    expect(r.checkedRegion).toBe('first-12000-chars-strong');
    expect(r.matchedTerm).toContain('legal:');
  });
});

describe('annual content verification', () => {
  it('does not classify annual reports as quarterly when strong annual markers exist', () => {
    const text = [
      'Annual report 2025',
      'Q4 2025 highlights',
      'Consolidated income statement',
      'Consolidated balance sheet',
      'Directors report',
      'Förvaltningsberättelse',
    ].join('\n');
    const r = verifyAnnualReportContent(text);
    expect(r.isQuarterlyReport).toBe(false);
    expect(r.isLikelyAnnualReport).toBe(true);
  });

  it('does not reject Q4+full-year combined report (mining/energy pattern) as quarterly', () => {
    // Simulate a "Q4 2025 and Full-Year 2025 Shareholder Report" — quarterly markers in
    // the cover but the document covers the complete fiscal year with financial statements.
    const text = [
      'Q4 2025 and Full-Year 2025 Shareholder Report',
      'Fourth Quarter and Full-Year Results',
      'Income Statement',
      'Balance Sheet',
      'Revenue 1 234',
      'Operating income 456',
    ].join('\n');
    const r = verifyAnnualReportContent(text);
    expect(r.isQuarterlyReport).toBe(false);
    expect(r.isLikelyAnnualReport).toBe(true);
  });

  it('still rejects a genuine Q1 interim report (no full-year signal)', () => {
    const text = [
      'Q1 2025 Interim Report',
      'First Quarter Results',
      'Income Statement',
      'Balance Sheet',
      'Revenue 300',
    ].join('\n');
    const r = verifyAnnualReportContent(text);
    expect(r.isQuarterlyReport).toBe(true);
  });

  it('accepts bank report income markers when income statement heading is absent', () => {
    const text = [
      'Annual and Sustainability Report 2025',
      'Consolidated Financial Statements',
      'Net interest income',
      'Operating income',
      'Profit before tax',
      'Statement of financial position',
    ].join('\n');
    const r = verifyAnnualReportContent(text);
    expect(r.hasIncomeStatement).toBe(true);
    expect(r.isLikelyAnnualReport).toBe(true);
  });
});

describe('crossValidateFiscalYear', () => {
  it('treats off-by-one year as match (no warning)', () => {
    const r = crossValidateFiscalYear(2025, 2026);
    expect(r.match).toBe(true);
    expect(r.warning).toBeNull();
  });

  it('warns on larger mismatch', () => {
    const r = crossValidateFiscalYear(2023, 2026);
    expect(r.match).toBe(false);
    expect(r.warning).toContain('mismatch');
  });
});
