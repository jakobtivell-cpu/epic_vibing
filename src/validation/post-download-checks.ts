// ---------------------------------------------------------------------------
// Post-download verification — catches wrong-entity, wrong-PDF-type, and
// fiscal-year mismatches BEFORE field extraction runs. Generic — no
// company-specific configuration required.
// ---------------------------------------------------------------------------

import type { EntityProfile } from '../entity/entity-profile';
import { deriveShortNames } from '../discovery/search-discovery';
import { createLogger } from '../utils/logger';

const log = createLogger('post-check');

// ---------------------------------------------------------------------------
// 1. Entity verification — is this PDF actually for the target company?
// ---------------------------------------------------------------------------

export interface EntityCheckResult {
  passed: boolean;
  /** Provenance label + matched text, e.g. `legal:stripped:Sandvik` or `org:digits:5560427220` */
  matchedTerm: string | null;
  checkedRegion: 'first-6000-chars';
}

const ENTITY_CHECK_CHARS = 6_000;

function stripLegalSuffixes(name: string): string {
  return name
    .replace(/\s*\(publ\)\s*$/i, '')
    .replace(/\s+AB\s*\(publ\)\s*$/i, '')
    .replace(/\s+AB\s*$/i, '')
    .trim();
}

/** Collapse patterns like "H & M" → "H&M" (word & word only, repeated). */
function collapseAmpersandBrands(name: string): string {
  let out = name;
  let prev = '';
  while (out !== prev) {
    prev = out;
    out = out.replace(/\b(\w)\s+&\s+(\w)\b/gi, '$1&$2');
  }
  return out.trim();
}

function regionHasDistinctiveToken(region: string, tokens?: string[]): boolean {
  if (!tokens?.length) return false;
  return tokens.some((t) => t.length >= 5 && region.includes(t.toLowerCase()));
}

function buildTickerVariants(ticker: string | null): string[] {
  if (!ticker) return [];
  let t = ticker.trim().toUpperCase().replace(/\s+/g, '');
  if (!t) return [];
  t = t.replace(/\.ST$/i, '');
  const out: string[] = [];
  const m = t.match(/^(.+)-([A-Z])$/);
  if (m) {
    const base = m[1];
    const cls = m[2];
    out.push(`${base} ${cls}`, `${base}-${cls}`);
    if (base.length >= 2) out.push(base);
  } else {
    out.push(t);
  }
  return out;
}

export interface EntityCheckTerm {
  needle: string;
  provenance: string;
}

/**
 * All substrings to search for in the first ~6000 chars of PDF text (order =
 * priority for logging; first hit wins in {@link verifyEntityInPdf}).
 */
export function buildEntityCheckTerms(entity: EntityProfile): EntityCheckTerm[] {
  const terms: EntityCheckTerm[] = [];
  const seen = new Set<string>();

  const add = (raw: string, provenance: string) => {
    const s = raw.trim();
    if (s.length < 2) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push({ needle: s, provenance });
  };

  const legal = entity.legalName.trim();
  add(legal, 'legal:full');

  const stripped = stripLegalSuffixes(legal);
  if (stripped.toLowerCase() !== legal.toLowerCase()) {
    add(stripped, 'legal:stripped-suffix');
  }

  const collapsedStrip = collapseAmpersandBrands(stripped);
  if (collapsedStrip.toLowerCase() !== stripped.toLowerCase()) {
    add(collapsedStrip, 'legal:collapsed-spacing');
  }

  const collapsedFull = collapseAmpersandBrands(legal);
  if (
    collapsedFull.toLowerCase() !== legal.toLowerCase() &&
    collapsedFull.toLowerCase() !== collapsedStrip.toLowerCase()
  ) {
    add(collapsedFull, 'legal:collapsed-full');
  }

  const display = entity.displayName.trim();
  if (display.toLowerCase() !== legal.toLowerCase()) {
    add(display, 'display:name');
  }

  const anchor = entity.searchAnchor.trim();
  if (anchor.toLowerCase() !== legal.toLowerCase() && anchor.toLowerCase() !== display.toLowerCase()) {
    add(anchor, 'search:anchor');
  }

  const dt = entity.distinctiveTokens;
  if (dt.length > 0) {
    const brand = dt[dt.length - 1];
    if (brand.length >= 3) {
      add(brand, 'entity:brand-token');
    }
  }
  for (const tok of dt) {
    if (tok.length >= 3) {
      add(tok, 'entity:distinctive-token');
    }
  }

  for (const sn of deriveShortNames(entity.searchAnchor, entity.ticker ?? undefined)) {
    add(sn, 'derived:short-name');
  }

  for (const tv of buildTickerVariants(entity.ticker)) {
    add(tv, 'ticker:variant');
  }

  if (entity.orgNumber) {
    const compact = entity.orgNumber.replace(/\s/g, '');
    add(compact, 'org:formatted');
    const digits = entity.orgNumber.replace(/\D/g, '');
    if (digits.length >= 8) {
      add(digits, 'org:digits');
    }
  }

  for (const al of entity.knownAliases) {
    add(al, 'alias:known');
  }

  return terms;
}

/**
 * Short / ticker-like needles on a high-ambiguity entity must co-occur with a
 * distinctive token in the same region (reduces false positives vs other groups).
 */
function weakNeedleAllowed(region: string, needleLower: string, entity: EntityProfile): boolean {
  if (needleLower.length >= 5) return true;
  if (entity.ambiguityLevel !== 'high') return true;
  return regionHasDistinctiveToken(region, entity.distinctiveTokens);
}

/**
 * Pass if any generated entity term appears in the first 6000 characters.
 */
export function verifyEntityInPdf(text: string, entity: EntityProfile): EntityCheckResult {
  const region = text.substring(0, ENTITY_CHECK_CHARS).toLowerCase();
  const terms = buildEntityCheckTerms(entity);

  for (const { needle, provenance } of terms) {
    const n = needle.toLowerCase();
    if (!region.includes(n)) continue;
    if (!weakNeedleAllowed(region, n, entity)) continue;

    const label = `${provenance}:${needle}`;
    log.info(`[${entity.displayName}] Entity check OK — matched ${label}`);
    return { passed: true, matchedTerm: label, checkedRegion: 'first-6000-chars' };
  }

  log.warn(
    `[${entity.displayName}] Entity check FAILED — no entity term matched in first ${ENTITY_CHECK_CHARS} chars`,
  );
  return { passed: false, matchedTerm: null, checkedRegion: 'first-6000-chars' };
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
