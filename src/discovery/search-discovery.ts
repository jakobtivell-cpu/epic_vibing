// ---------------------------------------------------------------------------
// Search-engine-based discovery — Step 1 in the generic fallback chain.
//
// Three-pronged approach:
//   A) Derive short names from ticker/legal name and construct likely domains.
//   B) Query search engines with filetype:pdf for direct PDF hits.
//   C) Construct direct PDF URLs on discovered/candidate domains.
//
// Also provides `directPdfSearch()` for a standalone reverse-discovery step
// that runs after multi-domain cycling fails (Step 4 in the new ladder).
// ---------------------------------------------------------------------------

import * as cheerio from 'cheerio';
import { ReportCandidate, SOURCE_SEARCH_DISCOVERY } from '../types';
import { fetchPage, headCheck } from '../utils/http-client';
import { createLogger } from '../utils/logger';
import { toAbsoluteHttpUrl } from '../utils/url-helpers';

const log = createLogger('search-discovery');

const CURRENT_YEAR = new Date().getFullYear();
const RECENT_FISCAL_YEAR = CURRENT_YEAR - 1;

export interface SearchDiscoveryResult {
  pdfCandidates: ReportCandidate[];
  discoveredWebsite: string | null;
  /** All candidate domains discovered (for multi-domain cycling). */
  allDiscoveredDomains: string[];
  /**
   * Domains inferred from search ("official website", IR) — pipeline merges these
   * after ticker.json seeds, before slug-HEAD guesses.
   */
  searchEngineDomains: string[];
  /** Domains that responded to HEAD on brand-derived URL guesses. */
  slugInferenceDomains: string[];
  irPageCandidates: string[];
}

// ---------------------------------------------------------------------------
// Smart name derivation — extract usable short names from ticker + legal name
// ---------------------------------------------------------------------------

const LEGAL_SUFFIXES = /\s*\b(ab|publ|ltd|plc|oyj|asa|inc|se|corporation|group|gruppen)\b\.?\s*/gi;
const PAREN_SUFFIX = /\s*\([^)]*\)\s*/g;

/**
 * Produce a list of search-friendly short names from a company name and ticker.
 * Used for domain inference, search queries, and URL construction.
 */
export function deriveShortNames(companyName: string, ticker?: string): string[] {
  const names = new Set<string>();

  // From ticker: strip .ST and share-class suffix → "SEB", "VOLV", "SAND"
  if (ticker) {
    const base = ticker.replace(/\.ST$/i, '').replace(/-[A-Z]$/i, '');
    if (base.length >= 2) names.add(base);
  }

  // From legal name: strip AB, (publ), common suffixes
  const stripped = companyName
    .replace(PAREN_SUFFIX, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (stripped.length >= 2) {
    names.add(stripped);
  }

  // Also try just the first distinctive word (for multi-word names)
  const words = stripped.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length > 1) {
    // Skip leading "AB", "Telefonaktiebolaget" etc.
    const skip = new Set(['ab', 'telefonaktiebolaget', 'aktiebolaget', 'svenska', 'the']);
    const first = words.find((w) => !skip.has(w.toLowerCase()));
    if (first && first.length >= 2) names.add(first);
  }

  // Always include the original name
  names.add(companyName);

  return [...names];
}

// ---------------------------------------------------------------------------
// Company domain inference — brand slugs from legal/display name (not ticker noise)
// ---------------------------------------------------------------------------

function companySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/(^-|-$)/g, '');
}

function companySlugHyphen(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const DOMAIN_STOPWORDS = new Set([
  'ab', 'publ', 'the', 'and', 'och', 'ltd', 'plc', 'oyj', 'asa', 'inc', 'group', 'gruppen',
  'telefonaktiebolaget', 'aktiebolaget', 'svenska', 'corporation', 'company', 'holding', 'equity',
  'partners',
  /** Avoid inventing www.international.com / international.se from "Lindab International AB". */
  'international',
]);

/**
 * Distinctive brand tokens for domain trust and URL guessing — derived from the
 * company / legal name, not from Nasdaq ticker slugs (avoids eric.se, ericb.com).
 */
export function extractBrandSlugsForDomains(companyOrLegalName: string): string[] {
  const slugs = new Set<string>();
  const raw = companyOrLegalName.trim();
  if (!raw) return [];

  const lower = raw.toLowerCase();

  if (/h\s*&\s*m|hennes\s*&\s*mauritz|\bhennes\b.*\bmauritz\b/i.test(raw)) {
    slugs.add('hm');
    slugs.add('hmgroup');
    slugs.add('hennes');
  }
  if (/\bericsson\b/i.test(raw)) slugs.add('ericsson');
  if (/\bvolvo\b/i.test(raw)) {
    slugs.add('volvo');
    slugs.add('volvogroup');
  }
  if (/\bessity\b/i.test(raw)) slugs.add('essity');
  if (/\bhexagon\b/i.test(raw)) slugs.add('hexagon');
  if (/\bsandvik\b/i.test(raw)) slugs.add('sandvik');
  if (/\batlas\s+copco\b/i.test(lower)) {
    slugs.add('atlascopco');
    slugs.add('atcogroup');
  }
  if (/\bsecuritas\b/i.test(raw)) slugs.add('securitas');
  if (/\balfa\s+laval\b/i.test(lower)) slugs.add('alfalaval');
  if (/\binvestor\s+ab\b/i.test(lower)) slugs.add('investorab');
  if (/\blindab\b/i.test(lower)) {
    slugs.add('lindab');
    slugs.add('lindabgroup');
  }

  const stripped = raw
    .replace(PAREN_SUFFIX, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const word of stripped.split(/\s+/)) {
    const w = word.replace(/[^a-zA-ZÅÄÖåäö0-9]/g, '').toLowerCase();
    if (w.length < 4 || DOMAIN_STOPWORDS.has(w)) continue;
    slugs.add(w);
  }

  if (slugs.size === 0) {
    const m = raw.match(/[A-Za-zÅÄÖåäö]{4,}/g);
    if (m) for (const x of m) slugs.add(x.toLowerCase());
  }

  return [...slugs];
}

/** Add Nasdaq ticker root for banks only — matches groupeseb.com (SEB) without enabling eric.se for Ericsson. */
export function mergeBankTickerSlugForTrust(companyName: string, ticker: string | undefined, slugs: string[]): string[] {
  const out = new Set(slugs);
  if (!ticker || !/bank|banken|bankaktiebolag/i.test(companyName)) return [...out];
  const tb = ticker.replace(/\.ST$/i, '').replace(/-[A-Z]$/i, '').toLowerCase();
  if (tb.length >= 2 && tb.length <= 5) out.add(tb);
  return [...out];
}

/** Host must visibly relate to at least one brand slug (blocks telepathy.com for H&M, eric.se for Ericsson). */
export function hostnameMatchesBrandTrust(hostname: string, brandSlugs: string[]): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  if (brandSlugs.length === 0) return true;
  return brandSlugs.some((slug) => slug.length >= 2 && h.includes(slug));
}

function buildLikelyUrlsFromBrandSlugs(brandSlugs: string[]): string[] {
  const candidates = new Set<string>();
  for (const slugRaw of brandSlugs) {
    const slug = companySlug(slugRaw);
    const slugHyphen = companySlugHyphen(slugRaw);
    if (slug.length < 2) continue;

    // Only www.{slug}.{com,se} per brand — avoids parallel bursts to the same host family (rate limits).
    candidates.add(`https://www.${slug}.com/`);
    candidates.add(`https://www.${slug}.se/`);

    if (slugHyphen !== slug && slugHyphen.length >= 2) {
      candidates.add(`https://www.${slugHyphen}.com/`);
      candidates.add(`https://www.${slugHyphen}.se/`);
    }
  }
  return [...candidates];
}

interface DomainCheckResult {
  primaryWebsite: string | null;
  allResolvedDomains: string[];
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function headCheckTrustedOrigins(
  urls: string[],
  companyName: string,
  brandSlugs: string[],
): Promise<DomainCheckResult> {
  log.info(`[${companyName}] HEAD-checking ${urls.length} brand-derived origins (sequential)`);

  let primaryWebsite: string | null = null;
  const allResolved: string[] = [];

  for (const domain of urls) {
    let url: string | null = null;
    try {
      const result = await headCheck(domain, 8_000);
      if (result.exists) {
        url = result.finalUrl ?? domain;
      }
    } catch {
      /* ignore */
    }
    await sleepMs(350);

    if (!url) continue;
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      if (!hostnameMatchesBrandTrust(hostname, brandSlugs)) {
        log.debug(`[${companyName}] Rejecting unrelated host from slug guess: ${hostname}`);
        continue;
      }
      if (!allResolved.some((u) => new URL(u).hostname.replace(/^www\./, '') === hostname)) {
        allResolved.push(url.replace(/\/$/, '') || url);
        if (!primaryWebsite) primaryWebsite = url.replace(/\/$/, '') || url;
      }
    } catch {
      allResolved.push(url);
      if (!primaryWebsite) primaryWebsite = url;
    }
  }

  if (primaryWebsite) {
    log.info(`[${companyName}] Slug-based website(s): ${allResolved.join(', ')}`);
  }

  return { primaryWebsite, allResolvedDomains: allResolved };
}

interface ScoredOrigin {
  url: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Search engine querying — try multiple engines
// ---------------------------------------------------------------------------

interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

const PORTAL_DOMAINS = /bing|google|duckduckgo|wikipedia|youtube|facebook|twitter|linkedin/i;

async function querySearchEngine(query: string): Promise<SearchResult[]> {
  const ddgResults = await queryDuckDuckGo(query);
  if (ddgResults.length > 0) return ddgResults;
  return queryBing(query);
}

async function queryDuckDuckGo(query: string): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encoded}`;

  log.debug(`DuckDuckGo search: "${query}"`);

  try {
    const result = await fetchPage(searchUrl, 15_000);
    if (!result.ok) return [];

    const $ = cheerio.load(result.response.data);
    const results: SearchResult[] = [];

    $('a[href*="uddg="]').each((_, el) => {
      let href = $(el).attr('href') ?? '';
      const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) {
        try { href = decodeURIComponent(uddgMatch[1]); } catch { return; }
      }
      if (!href.startsWith('http') || /duckduckgo\.com/i.test(href)) return;
      const title = $(el).text().trim();
      if (title && !results.some((r) => r.url === href)) {
        results.push({ url: href, title, snippet: '' });
      }
    });

    if (results.length > 0) {
      log.info(`DuckDuckGo returned ${results.length} results`);
    }
    return results;
  } catch {
    return [];
  }
}

async function queryBing(query: string): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const searchUrl = `https://www.bing.com/search?q=${encoded}`;

  log.debug(`Bing search: "${query}"`);

  try {
    const result = await fetchPage(searchUrl, 15_000);
    if (!result.ok) return [];

    const $ = cheerio.load(result.response.data);
    const results: SearchResult[] = [];

    $('li.b_algo h2 a, .b_algo h2 a').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (!href.startsWith('http')) return;
      const title = $(el).text().trim();
      const snippet = $(el).closest('.b_algo, li').find('.b_caption p, .b_paractl').text().trim();
      if (title && !results.some((r) => r.url === href)) {
        results.push({ url: href, title, snippet });
      }
    });

    if (results.length > 0) {
      log.info(`Bing returned ${results.length} results`);
    }
    return results;
  } catch {
    return [];
  }
}

/** Shorter label for search engines — avoids timeouts on very long legal names. */
function searchQueryLabel(fullName: string): string {
  let s = fullName
    .replace(PAREN_SUFFIX, ' ')
    .replace(/\s*\(publ\)\s*/gi, ' ')
    .replace(/^\s*telefonaktiebolaget\s+/i, '')
    .replace(/^\s*aktiebolaget\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= 52) return s;
  return `${s.slice(0, 49).trim()}…`;
}

async function discoverCorporateDomainsFromSearch(
  companyName: string,
  brandSlugs: string[],
): Promise<string[]> {
  const label = searchQueryLabel(companyName);
  const queries = [
    `${label} official website sweden`,
    `${label} corporate website`,
    `${label} investor relations`,
  ];

  const scored: ScoredOrigin[] = [];
  const seenHost = new Set<string>();

  for (const query of queries) {
    const results = await querySearchEngine(query);
    for (const r of results) {
      if (/\.pdf(\?|$)/i.test(r.url)) continue;
      let hostname = '';
      let originUrl: string;
      try {
        const u = new URL(r.url);
        hostname = u.hostname.replace(/^www\./, '').toLowerCase();
        if (PORTAL_DOMAINS.test(hostname)) continue;
        if (/allabolag|avanza|nasdaq|bloomberg|wikipedia|reuters|ft\.com|di\.se/i.test(hostname)) {
          continue;
        }
        if (!hostnameMatchesBrandTrust(hostname, brandSlugs)) continue;
        originUrl = `${u.protocol}//${u.hostname}/`;
      } catch {
        continue;
      }

      if (seenHost.has(hostname)) continue;

      try {
        const head = await headCheck(originUrl, 8_000);
        if (!head.exists) continue;
        const final = (head.finalUrl ?? originUrl).replace(/\/$/, '');
        seenHost.add(hostname);

        let score = 0;
        for (const s of brandSlugs) {
          if (hostname.includes(s)) score += Math.min(s.length, 12);
        }
        const blob = `${r.url} ${r.title} ${r.snippet}`.toLowerCase();
        if (/investor|investerare|ir\b|financial\s+reports/i.test(blob)) score += 8;
        if (/official|corporate|homepage|hemsida/i.test(blob)) score += 4;

        scored.push({ url: final, score });
      } catch {
        /* skip */
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const ordered = scored.map((s) => s.url);
  if (ordered.length > 0) {
    log.info(`[${companyName}] Search discovered corporate site(s): ${ordered.join(', ')}`);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// URL scoring for search results
// ---------------------------------------------------------------------------

const TRUSTED_IR_PLATFORMS = /cision\.com|mfn\.se|newsweb\.com|globenewswire\.com|publish\.ne\.cision/i;

function scorePdfCandidate(
  url: string,
  title: string,
  snippet: string,
  shortNames: string[],
): number {
  if (!/\.pdf(\?|$)/i.test(url)) return -999;

  let score = 5;
  const combined = `${title} ${snippet}`.toLowerCase();
  const urlLower = url.toLowerCase();

  if (/annual\s*(?:and\s*sustainability\s*)?\s*report/i.test(combined)) score += 10;
  if (/årsredovisning/i.test(combined)) score += 10;
  if (/annual.report|arsredovisning|årsredovisning/i.test(urlLower)) score += 6;

  if (/press|pressrelease|\/news\//i.test(urlLower)) score -= 10;
  if (/interim|quarterly|q[1-4]/i.test(combined)) score -= 10;
  if (/governance|remuneration/i.test(combined)) score -= 8;
  if (
    /voting|postal[\s-]*voting|postal[\s-]*vote|kallelse|bolagsst(a|ä)mma|stämma|röstmaterial|notice\s+of\s+(?:the\s+)?(?:annual|general)/i.test(
      combined,
    )
  ) {
    score -= 22;
  }
  if (/\bagm\b|\bproxy\b/i.test(combined)) score -= 14;
  if (/voting|kallelse|proxy|bolagsst(a|ä)mma|stämma|röstmaterial|\bagm\b|postal/i.test(urlLower)) {
    score -= 22;
  }
  if (/summary|sammandrag/i.test(combined)) score -= 3;

  const nameTokens = shortNames
    .flatMap((n) => n.toLowerCase().split(/[^a-z0-9åäö]+/i))
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !DOMAIN_STOPWORDS.has(t));
  const haystack = `${urlLower} ${combined}`;
  const tokenMatched = nameTokens.some((t) => haystack.includes(t));

  const yearMatch = url.match(/\b(20[12]\d)\b/) ?? title.match(/\b(20[12]\d)\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    if (year === RECENT_FISCAL_YEAR || year === CURRENT_YEAR) score += 5;
    else if (year === RECENT_FISCAL_YEAR - 1) score += 2;
    else if (year < RECENT_FISCAL_YEAR - 2) score -= 5 * (RECENT_FISCAL_YEAR - year - 2);
  }

  // Domain trust: bonus if URL domain contains one of the short names
  let hostMatched = false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const sn of shortNames) {
      if (hostname.includes(sn.toLowerCase())) {
        score += 4;
        hostMatched = true;
        break;
      }
    }
    if (TRUSTED_IR_PLATFORMS.test(hostname)) {
      score += 3;
    }
  } catch { /* skip */ }

  // If neither the host nor the candidate text mentions company tokens,
  // this is usually a cross-company false positive from broad search results.
  if (!hostMatched && !tokenMatched) {
    score -= 14;
  }

  return score;
}

function isIrPage(url: string, title: string): boolean {
  const combined = `${url} ${title}`.toLowerCase();
  return (
    /investor.?relations/i.test(combined) ||
    /\/investors?\b/i.test(url) ||
    /investerare/i.test(combined) ||
    (/annual.report/i.test(combined) && !/\.pdf/i.test(url))
  );
}

// ---------------------------------------------------------------------------
// Direct PDF URL construction — try common annual report URL patterns
// ---------------------------------------------------------------------------

function buildDirectPdfUrls(shortNames: string[], websites: string[]): ReportCandidate[] {
  const candidates: ReportCandidate[] = [];
  const seen = new Set<string>();
  const years = [RECENT_FISCAL_YEAR, CURRENT_YEAR];

  for (const website of websites) {
    const base = toAbsoluteHttpUrl(website);
    if (!base) continue;

    for (const name of shortNames) {
      const slug = companySlugHyphen(name);
      const slugCompact = companySlug(name);
      if (slug.length < 2) continue;

      const patterns = [
        `${base}/${slug}-annual-report-{year}.pdf`,
        `${base}/${slug}-annual-and-sustainability-report-{year}.pdf`,
        `${base}/investors/annual-report-{year}.pdf`,
        `${base}/globalassets/${slug}-annual-report-{year}.pdf`,
        `${base}/assets/annual-report-{year}.pdf`,
        `${base}/annual-report-{year}.pdf`,
        // Swedish IR infrastructure patterns
        `${base}/siteassets/investor_relations/${slugCompact}_annual_report_{year}.pdf`,
        `${base}/siteassets/about_${slugCompact}/annual_reports/${slugCompact}_annual_report_{year}.pdf`,
        `${base}/siteassets/${slug}-annual-report-{year}.pdf`,
        // AEM-style CMS
        `${base}/content/dam/${slug}/annual-report-{year}.pdf`,
        `${base}/content/dam/${slugCompact}/investors/annual-report-{year}.pdf`,
      ];

      for (const year of years) {
        for (const pattern of patterns) {
          const url = pattern.replace(/\{year\}/g, String(year));
          if (seen.has(url)) continue;
          seen.add(url);
          candidates.push({
            url,
            score: 8 + (year === RECENT_FISCAL_YEAR ? 3 : 0),
            text: `[direct-url] ${slug}-annual-report-${year}`,
            source: SOURCE_SEARCH_DISCOVERY,
          });
        }
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Main entry point — Step 1 discovery
// ---------------------------------------------------------------------------

function hostnameKeyFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function dedupeOriginsByHost(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    try {
      const abs = toAbsoluteHttpUrl(raw);
      if (!abs) continue;
      const u = new URL(abs);
      const h = u.hostname.replace(/^www\./, '').toLowerCase();
      if (seen.has(h)) continue;
      seen.add(h);
      out.push(abs);
    } catch {
      /* skip */
    }
  }
  return out;
}

function appendTrustedOrigin(
  list: string[],
  hostSeen: Set<string>,
  originLike: string,
  brandSlugs: string[],
): void {
  try {
    const u = new URL(originLike);
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (hostSeen.has(h)) return;
    if (!hostnameMatchesBrandTrust(h, brandSlugs)) return;
    hostSeen.add(h);
    list.push(`${u.protocol}//${u.hostname}`.replace(/\/$/, ''));
  } catch {
    /* skip */
  }
}

/**
 * @param companyName  Primary search term (legal name or user-supplied name)
 * @param ticker       Optional raw ticker symbol (e.g. "SEB-A.ST")
 * @param trustedSeeds Optional high-trust origins from ticker.json — no extra HEAD burst on those hosts
 */
export async function searchDiscovery(
  companyName: string,
  ticker?: string,
  trustedSeeds?: string[],
): Promise<SearchDiscoveryResult> {
  log.info(`[${companyName}] Starting search-engine-based discovery${ticker ? ` (ticker: ${ticker})` : ''}`);

  const brandSlugs = mergeBankTickerSlugForTrust(
    companyName,
    ticker,
    extractBrandSlugsForDomains(companyName),
  );
  log.info(`[${companyName}] Brand slugs for domain trust: ${brandSlugs.join(', ')}`);

  const shortNames = deriveShortNames(companyName, ticker);
  log.info(`[${companyName}] Derived short names: ${shortNames.join(', ')}`);

  const seedDeduped = dedupeOriginsByHost(trustedSeeds ?? []);
  const seedHostKeys = new Set(
    seedDeduped.map((u) => hostnameKeyFromUrl(u)).filter((k): k is string => k !== null),
  );
  if (seedDeduped.length > 0) {
    log.info(`[${companyName}] Trusted seed domains (from config): ${seedDeduped.join(', ')}`);
  }

  const searchEngineDomains = dedupeOriginsByHost([
    ...seedDeduped,
    ...(await discoverCorporateDomainsFromSearch(companyName, brandSlugs)),
  ]);

  const slugGuessUrls = buildLikelyUrlsFromBrandSlugs(brandSlugs).filter((u) => {
    const k = hostnameKeyFromUrl(u);
    return k !== null && !seedHostKeys.has(k);
  });
  const slugResult = await headCheckTrustedOrigins(slugGuessUrls, companyName, brandSlugs);
  const slugInferenceDomains = dedupeOriginsByHost(slugResult.allResolvedDomains);

  let discoveredWebsite = searchEngineDomains[0] ?? slugResult.primaryWebsite ?? null;

  const allDiscoveredDomains = dedupeOriginsByHost([...searchEngineDomains, ...slugInferenceDomains]);
  const hostSeen = new Set<string>();
  for (const raw of allDiscoveredDomains) {
    try {
      const h = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
        .hostname.replace(/^www\./, '')
        .toLowerCase();
      hostSeen.add(h);
    } catch {
      /* skip */
    }
  }

  const pdfCandidates: ReportCandidate[] = [];
  const irPageCandidates: string[] = [];
  const seenUrls = new Set<string>();

  // Phase B: Search engine queries with filetype:pdf and short-name variants
  const queries: string[] = [];
  for (const sn of shortNames.slice(0, 3)) {
    queries.push(`${sn} annual report ${RECENT_FISCAL_YEAR} filetype:pdf`);
    queries.push(`${sn} årsredovisning ${RECENT_FISCAL_YEAR} filetype:pdf`);
    queries.push(`${sn} investor relations annual report`);
  }

  for (const query of queries) {
    const results = await querySearchEngine(query);

    for (const r of results) {
      if (seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);

      if (!r.url.endsWith('.pdf')) {
        try {
          const u = new URL(r.url);
          const hostname = u.hostname.replace(/^www\./, '').toLowerCase();
          if (!PORTAL_DOMAINS.test(hostname) && !/allabolag|avanza|nasdaq|bloomberg/i.test(hostname)) {
            const domainUrl = `https://${u.hostname}/`;
            appendTrustedOrigin(allDiscoveredDomains, hostSeen, domainUrl, brandSlugs);
            if (!discoveredWebsite && hostnameMatchesBrandTrust(hostname, brandSlugs)) {
              discoveredWebsite = domainUrl.replace(/\/$/, '');
              log.info(`[${companyName}] Discovered website from PDF/IR search: ${discoveredWebsite}`);
            }
          }
        } catch { /* skip */ }
      }

      const pdfScore = scorePdfCandidate(r.url, r.title, r.snippet, shortNames);
      if (pdfScore > 0) {
        pdfCandidates.push({
          url: r.url,
          score: pdfScore,
          text: `[search] ${r.title.substring(0, 100)}`,
          source: SOURCE_SEARCH_DISCOVERY,
        });
      }

      if (isIrPage(r.url, r.title)) {
        irPageCandidates.push(r.url);
      }
    }
  }

  // Phase C: Direct PDF URL construction using all discovered domains
  if (allDiscoveredDomains.length > 0) {
    const directCandidates = buildDirectPdfUrls(shortNames, allDiscoveredDomains);
    for (const c of directCandidates) {
      if (!seenUrls.has(c.url)) {
        seenUrls.add(c.url);
        pdfCandidates.push(c);
      }
    }
  }

  pdfCandidates.sort((a, b) => b.score - a.score);

  log.info(
    `[${companyName}] Search discovery: ${pdfCandidates.length} PDF candidates, ${irPageCandidates.length} IR pages, website: ${discoveredWebsite ?? 'unknown'}, domains: ${allDiscoveredDomains.length}`,
  );

  for (const c of pdfCandidates.slice(0, 5)) {
    log.info(`[${companyName}]   ${c.score}pts — "${c.text}" — ${c.url}`);
  }

  return {
    pdfCandidates,
    discoveredWebsite,
    allDiscoveredDomains,
    searchEngineDomains,
    slugInferenceDomains,
    irPageCandidates,
  };
}

// ---------------------------------------------------------------------------
// Direct PDF search — Step 4 "reverse discovery" (no website required)
// ---------------------------------------------------------------------------

/**
 * Standalone reverse-discovery step: queries Bing with explicit filetype:pdf
 * and constructs direct PDF URLs on known/candidate domains, then HEAD-checks
 * the most promising ones. Runs independently of website resolution.
 */
export async function directPdfSearch(
  companyName: string,
  ticker?: string,
  candidateDomains?: string[],
): Promise<ReportCandidate[]> {
  log.info(`[${companyName}] === Direct PDF search (reverse discovery) ===`);

  const shortNames = deriveShortNames(companyName, ticker);
  const pdfCandidates: ReportCandidate[] = [];
  const seenUrls = new Set<string>();

  // Bing searches with filetype:pdf
  const queries: string[] = [];
  for (const sn of shortNames.slice(0, 3)) {
    queries.push(`"${sn}" annual report ${RECENT_FISCAL_YEAR} filetype:pdf`);
    queries.push(`"${sn}" årsredovisning ${RECENT_FISCAL_YEAR} filetype:pdf`);
  }
  if (ticker) {
    const base = ticker.replace(/\.ST$/i, '').replace(/-[A-Z]$/i, '');
    queries.push(`"${base}" annual report ${RECENT_FISCAL_YEAR} filetype:pdf`);
  }

  for (const query of queries) {
    const results = await querySearchEngine(query);
    for (const r of results) {
      if (seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      const score = scorePdfCandidate(r.url, r.title, r.snippet, shortNames);
      if (score > 0) {
        pdfCandidates.push({
          url: r.url,
          score,
          text: `[direct-search] ${r.title.substring(0, 100)}`,
          source: SOURCE_SEARCH_DISCOVERY,
        });
      }
    }
  }

  // Construct and HEAD-check direct URLs on candidate domains
  if (candidateDomains && candidateDomains.length > 0) {
    const directCandidates = buildDirectPdfUrls(shortNames, candidateDomains);
    const toCheck = directCandidates
      .filter((c) => !seenUrls.has(c.url))
      .slice(0, 20);

    log.info(`[${companyName}] HEAD-checking ${toCheck.length} direct PDF URLs`);

    const headResults = await Promise.allSettled(
      toCheck.map(async (c) => {
        try {
          const result = await headCheck(c.url, 10_000);
          if (result.exists && /pdf/i.test(result.contentType ?? '')) {
            return c;
          }
        } catch { /* ignore */ }
        return null;
      }),
    );

    for (const r of headResults) {
      if (r.status === 'fulfilled' && r.value) {
        r.value.score += 10; // Confirmed to exist
        pdfCandidates.push(r.value);
        seenUrls.add(r.value.url);
      }
    }
  }

  pdfCandidates.sort((a, b) => b.score - a.score);

  log.info(`[${companyName}] Direct PDF search: ${pdfCandidates.length} candidates found`);
  for (const c of pdfCandidates.slice(0, 5)) {
    log.info(`[${companyName}]   ${c.score}pts — "${c.text}" — ${c.url}`);
  }

  return pdfCandidates;
}
