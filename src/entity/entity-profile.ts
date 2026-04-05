// ---------------------------------------------------------------------------
// Canonical entity profile — resolved before discovery.
// Legal name and org number are high-trust anchors; short ticker aliases are
// low-trust when the legal entity is long / distinctive (ambiguity risk).
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import { join } from 'path';
import { CompanyProfile } from '../types';
import { createLogger } from '../utils/logger';
import { deriveShortNames } from '../discovery/search-discovery';

const log = createLogger('entity-profile');

export type AmbiguityLevel = 'low' | 'medium' | 'high';

/** Soft hint only — never used to skip pipeline steps or force company type. */
export type ReportingModelHint = 'unspecified' | 'industrial' | 'bank' | 'investment_company';

export interface HostnameRejectRule {
  ifLegalNameMatches: string;
  rejectHostSubstrings: string[];
}

export interface EntityProfile {
  displayName: string;
  legalName: string;
  ticker: string | null;
  orgNumber: string | null;
  /** Highest-trust string for search engines and primary entity verification */
  searchAnchor: string;
  canonicalNames: string[];
  /** Ticker base and other short forms — use with care when ambiguity is high */
  aliasNamesLowTrust: string[];
  /** Long tokens from legal name used to validate URLs and PDFs */
  distinctiveTokens: string[];
  ambiguityLevel: AmbiguityLevel;
  reportingModelHint: ReportingModelHint;
  hostnameRejectRules: HostnameRejectRule[];
  /** Merged candidate domains from CompanyProfile */
  seedCandidateDomains: string[];
}

interface ConfusionFile {
  hostnameRejectRules?: HostnameRejectRule[];
}

let cachedRules: HostnameRejectRule[] | null = null;

function resolveEntityConfusionPath(): string | null {
  const filename = 'entity-confusion.json';
  const candidates = [
    join(process.cwd(), 'data', filename),
    join(__dirname, '..', '..', 'data', filename),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadHostnameRejectRules(): HostnameRejectRule[] {
  if (cachedRules !== null) return cachedRules;
  const p = resolveEntityConfusionPath();
  try {
    if (!p) {
      cachedRules = [];
      return cachedRules;
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as ConfusionFile;
    const rules = (raw.hostnameRejectRules ?? []).filter(
      (r) => typeof r.ifLegalNameMatches === 'string' && Array.isArray(r.rejectHostSubstrings),
    );
    cachedRules = rules;
    log.debug(`Loaded ${rules.length} hostname reject rules from entity-confusion.json`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`entity-confusion.json not loaded (${msg}) — continuing without extra rules`);
    cachedRules = [];
  }
  return cachedRules;
}

const SKIP_LEGAL_WORDS = new Set([
  'ab', 'publ', 'the', 'and', 'och', 'ltd', 'plc', 'oyj', 'asa', 'inc', 'group', 'gruppen',
]);

function distinctiveTokensFromLegal(legal: string): string[] {
  const words = legal
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zåäöéü0-9]/gi, ''))
    .filter((w) => w.length >= 5 && !SKIP_LEGAL_WORDS.has(w));
  return [...new Set(words)];
}

function tickerBase(ticker?: string): string | null {
  if (!ticker) return null;
  const base = ticker.replace(/\.ST$/i, '').replace(/-[A-Z]$/i, '');
  return base.length >= 2 ? base : null;
}

function computeAmbiguity(legal: string, ticker?: string): AmbiguityLevel {
  const base = tickerBase(ticker);
  const tokens = distinctiveTokensFromLegal(legal);
  if (!base || base.length > 4) return 'low';
  if (legal.length < 24 && tokens.length < 2) return 'low';
  if (tokens.length >= 2 && base.length <= 4) return 'high';
  if (tokens.length >= 1 && base.length <= 3) return 'high';
  return 'medium';
}

function reportingHintFromLegal(legal: string): ReportingModelHint {
  const l = legal.toLowerCase();
  if (/\bbank\b|banken|bankaktiebolag|enskilda/.test(l)) return 'bank';
  if (/investment\s*company|investmentbolag|investor\s+ab/.test(l)) return 'investment_company';
  return 'unspecified';
}

/**
 * Build a canonical entity profile from CLI/ticker-resolved CompanyProfile.
 */
export function buildEntityProfile(company: CompanyProfile): EntityProfile {
  const legalName = (company.legalName ?? company.name).trim();
  const displayName = company.name.trim();
  const searchAnchor = (company.legalName ?? company.name).trim();
  const shortNames = deriveShortNames(searchAnchor, company.ticker);
  const tb = tickerBase(company.ticker);
  const aliasNamesLowTrust = shortNames.filter((s) => {
    if (s.length < 3) return false;
    if (tb && s.toUpperCase() === tb.toUpperCase()) return true;
    return s.length <= 5 && s !== searchAnchor;
  });

  const canonicalNames = [...new Set([legalName, displayName, searchAnchor].filter(Boolean))];
  const distinctiveTokens = distinctiveTokensFromLegal(legalName);
  const ambiguityLevel = computeAmbiguity(legalName, company.ticker);
  const hostnameRejectRules = loadHostnameRejectRules();
  const seedCandidateDomains = [...(company.candidateDomains ?? [])];

  log.info(
    `[entity] searchAnchor="${searchAnchor}" ambiguity=${ambiguityLevel} tokens=[${distinctiveTokens.slice(0, 5).join(', ')}]`,
  );

  return {
    displayName,
    legalName,
    ticker: company.ticker ?? null,
    orgNumber: company.orgNumber ?? null,
    searchAnchor,
    canonicalNames,
    aliasNamesLowTrust,
    distinctiveTokens,
    ambiguityLevel,
    reportingModelHint: reportingHintFromLegal(legalName),
    hostnameRejectRules,
    seedCandidateDomains,
  };
}

/** True if URL hostname should be rejected for this entity (wrong-brand collision). */
export function shouldRejectReportUrl(url: string, profile: EntityProfile): boolean {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const legal = profile.legalName;
  for (const rule of profile.hostnameRejectRules) {
    try {
      const pattern = rule.ifLegalNameMatches.replace(/^\(\?i\)/, '');
      const re = new RegExp(pattern, 'i');
      if (!re.test(legal)) continue;
      for (const sub of rule.rejectHostSubstrings) {
        if (hostname.includes(sub.toLowerCase())) {
          log.warn(`[entity] Rejecting URL host collision: ${hostname} (rule matches legal name)`);
          return true;
        }
      }
    } catch {
      /* bad regex in file */
    }
  }
  return false;
}
