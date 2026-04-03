// ---------------------------------------------------------------------------
// Post-download verification — catches wrong-entity, wrong-PDF-type, and
// fiscal-year mismatches BEFORE field extraction runs. These checks exist
// because the discovery heuristics can't guarantee correctness; they only
// rank candidates. A single misranked link produces a plausible, confident,
// and completely wrong result without these gates.
// ---------------------------------------------------------------------------

import { CompanyProfile } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('post-check');

// ---------------------------------------------------------------------------
// 1. Entity verification — is this PDF actually for the target company?
// ---------------------------------------------------------------------------

export interface EntityCheckResult {
  passed: boolean;
  matchedTerm: string | null;
  checkedRegion: 'first-2-pages';
}

const FIRST_TWO_PAGES_CHARS = 6_000;

export function verifyEntityInPdf(
  text: string,
  company: CompanyProfile,
): EntityCheckResult {
  const region = text.substring(0, FIRST_TWO_PAGES_CHARS).toLowerCase();

  const terms = [
    company.name,
    company.ticker.replace(/\s+/g, ''),
    ...company.knownAliases,
  ];

  for (const term of terms) {
    if (!term) continue;
    const lower = term.toLowerCase();
    if (lower.length < 2) continue;
    if (region.includes(lower)) {
      return { passed: true, matchedTerm: term, checkedRegion: 'first-2-pages' };
    }
  }

  log.warn(
    `[${company.name}] Entity check FAILED — none of [${terms.join(', ')}] found in first ${FIRST_TWO_PAGES_CHARS} chars`,
  );
  return { passed: false, matchedTerm: null, checkedRegion: 'first-2-pages' };
}

// ---------------------------------------------------------------------------
// 2. Annual report content verification — is this actually an annual report?
// ---------------------------------------------------------------------------

export interface ContentCheckResult {
  isLikelyAnnualReport: boolean;
  hasIncomeStatement: boolean;
  hasBalanceSheet: boolean;
  isQuarterlyReport: boolean;
  isGovernanceReport: boolean;
  warnings: string[];
}

const ANNUAL_REPORT_MARKERS: RegExp[] = [
  /consolidated\s+(income\s+statement|statement\s+of\s+(income|profit|loss))/i,
  /resultaträkning/i,
  /consolidated\s+(balance\s+sheet|statement\s+of\s+financial\s+position)/i,
  /balansräkning/i,
  /income\s+statement/i,
  /balance\s+sheet/i,
  /annual\s+report/i,
  /årsredovisning/i,
  /directors['']?\s+report/i,
  /förvaltningsberättelse/i,
];

const QUARTERLY_MARKERS: RegExp[] = [
  /\bQ[1-4]\s+\d{4}\b/i,
  /\binterim\s+report\b/i,
  /\bdelårsrapport\b/i,
  /\bquarterly\s+report\b/i,
  /\bfirst\s+quarter\b/i,
  /\bsecond\s+quarter\b/i,
  /\bthird\s+quarter\b/i,
  /\bfourth\s+quarter\b/i,
  /\bjanuary\s*[-–]\s*(?:march|june|september)\b/i,
  /\bjanuari\s*[-–]\s*(?:mars|juni|september)\b/i,
];

const GOVERNANCE_MARKERS: RegExp[] = [
  /\bcorporate\s+governance\s+report\b/i,
  /\bbolagsstyrningsrapport\b/i,
  /\bremuneration\s+report\b/i,
  /\bersättningsrapport\b/i,
];

export function verifyAnnualReportContent(text: string): ContentCheckResult {
  const lower = text.toLowerCase();
  const warnings: string[] = [];

  const hasIncomeStatement =
    /resultaträkning/i.test(lower) ||
    /income\s+statement/i.test(lower) ||
    /statement\s+of\s+(income|profit|loss)/i.test(lower);

  const hasBalanceSheet =
    /balansräkning/i.test(lower) ||
    /balance\s+sheet/i.test(lower) ||
    /statement\s+of\s+financial\s+position/i.test(lower);

  const annualMarkerCount = ANNUAL_REPORT_MARKERS.filter((p) => p.test(lower)).length;

  const first5000 = lower.substring(0, 5_000);
  const isQuarterlyReport = QUARTERLY_MARKERS.some((p) => p.test(first5000));
  const isGovernanceReport =
    GOVERNANCE_MARKERS.some((p) => p.test(first5000)) && annualMarkerCount < 3;

  if (isQuarterlyReport) {
    warnings.push('PDF appears to be a quarterly/interim report, not an annual report');
  }
  if (isGovernanceReport) {
    warnings.push('PDF appears to be a governance report, not an annual report');
  }
  if (!hasIncomeStatement) {
    warnings.push('No income statement / resultaträkning found in PDF');
  }
  if (!hasBalanceSheet) {
    warnings.push('No balance sheet / balansräkning found in PDF');
  }

  const isLikelyAnnualReport =
    !isQuarterlyReport && !isGovernanceReport && (hasIncomeStatement || annualMarkerCount >= 2);

  return {
    isLikelyAnnualReport,
    hasIncomeStatement,
    hasBalanceSheet,
    isQuarterlyReport,
    isGovernanceReport,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 3. Fiscal year cross-validation
// ---------------------------------------------------------------------------

export interface FiscalYearCheckResult {
  match: boolean;
  extractedYear: number | null;
  discoveryYear: number | null;
  warning: string | null;
}

export function crossValidateFiscalYear(
  extractedYear: number | null,
  discoveryYear: number | null,
): FiscalYearCheckResult {
  if (extractedYear === null || discoveryYear === null) {
    return {
      match: extractedYear === discoveryYear,
      extractedYear,
      discoveryYear,
      warning: null,
    };
  }

  if (extractedYear !== discoveryYear) {
    const warning =
      `Fiscal year mismatch: PDF text says ${extractedYear}, report URL/discovery says ${discoveryYear}`;
    log.warn(warning);
    return { match: false, extractedYear, discoveryYear, warning };
  }

  return { match: true, extractedYear, discoveryYear, warning: null };
}
