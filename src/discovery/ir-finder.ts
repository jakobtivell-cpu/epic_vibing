// ---------------------------------------------------------------------------
// IR page discovery — heuristic-driven fallback ladder.
//
// Strategy:
//   1. Try irHints from company profile (fastest, most reliable)
//   2. Scan homepage anchors and score them
//   3. Brute-force common IR paths
//   4. Check sitemap.xml for investor-related URLs
//
// Every candidate is scored, ranked, and validated before acceptance.
// ---------------------------------------------------------------------------

import * as cheerio from 'cheerio';
import { CompanyProfile, StageResult } from '../types';
import { fetchPage } from '../utils/http-client';
import { resolveUrl, isSameSite, getPath } from '../utils/url-helpers';
import { createLogger } from '../utils/logger';

const log = createLogger('ir-finder');

// ---- Scoring constants ----

interface ScoredCandidate {
  url: string;
  score: number;
  source: string;
}

/** Text patterns to match against anchor text (case-insensitive). */
const TEXT_SCORES: { pattern: RegExp; points: number }[] = [
  { pattern: /investor\s*relations/i, points: 10 },
  { pattern: /^investors$/i, points: 8 },
  { pattern: /investerare/i, points: 8 },
  { pattern: /investor/i, points: 6 },
  { pattern: /financial\s*reports/i, points: 5 },
  { pattern: /årsredovisning/i, points: 5 },
  { pattern: /annual\s*report/i, points: 4 },
  { pattern: /\breports\b/i, points: 3 },
];

/** Path patterns to match against the href. */
const PATH_SCORES: { pattern: RegExp; points: number }[] = [
  { pattern: /\/investor/i, points: 5 },
  { pattern: /\/ir\//i, points: 4 },
  { pattern: /\/reports/i, points: 3 },
];

/** Penalty keywords — if anchor text contains these, it's a subsection, not the main IR page. */
const PENALTY_KEYWORDS: { pattern: RegExp; points: number }[] = [
  { pattern: /calendar/i, points: -5 },
  { pattern: /contact/i, points: -5 },
  { pattern: /governance/i, points: -5 },
  { pattern: /press/i, points: -5 },
  { pattern: /news/i, points: -5 },
  { pattern: /career/i, points: -5 },
  { pattern: /cookie/i, points: -10 },
  { pattern: /privacy/i, points: -10 },
  { pattern: /legal/i, points: -10 },
];

/** Language bonus for English paths. */
const LANG_BONUS: { pattern: RegExp; points: number }[] = [
  { pattern: /\/en\//i, points: 2 },
];

/** Common IR path fragments to brute-force in step 3. */
const COMMON_IR_PATHS = [
  '/investors',
  '/en/investors',
  '/investor-relations',
  '/en/investor-relations',
  '/investerare',
  '/en/investerare',
  '/reports',
  '/financial-reports',
  '/en/reports',
  '/en/financial-reports',
];

// ---- Scoring functions ----

function scoreCandidate(text: string, href: string): number {
  let score = 0;

  for (const { pattern, points } of TEXT_SCORES) {
    if (pattern.test(text)) {
      score += points;
    }
  }

  for (const { pattern, points } of PATH_SCORES) {
    if (pattern.test(href)) {
      score += points;
    }
  }

  for (const { pattern, points } of PENALTY_KEYWORDS) {
    if (pattern.test(text)) {
      score += points; // points are negative
    }
  }

  for (const { pattern, points } of LANG_BONUS) {
    if (pattern.test(href)) {
      score += points;
    }
  }

  return score;
}

// ---- Validation gate ----

/**
 * Fetch a candidate IR page and check that it looks like a real IR page:
 * - Contains a .pdf link, OR
 * - Contains "annual report" or "årsredovisning" text, OR
 * - Contains year references (2024, 2025, etc.)
 */
async function validateIrPage(url: string): Promise<boolean> {
  log.debug(`Validating IR candidate: ${url}`);

  const result = await fetchPage(url, 10_000);
  if (!result.ok) {
    log.debug(`Validation fetch failed for ${url}: ${result.error.message}`);
    return false;
  }

  const html = result.response.data;
  const lower = html.toLowerCase();

  const hasPdfLink = /href\s*=\s*["'][^"']*\.pdf/i.test(html);
  const hasAnnualReport =
    lower.includes('annual report') || lower.includes('årsredovisning');
  const currentYear = new Date().getFullYear();
  const hasYearRef =
    html.includes(String(currentYear)) ||
    html.includes(String(currentYear - 1));

  const passed = hasPdfLink || hasAnnualReport || hasYearRef;

  log.debug(
    `Validation for ${url}: pdf=${hasPdfLink}, annualReport=${hasAnnualReport}, yearRef=${hasYearRef} → ${passed ? 'PASS' : 'FAIL'}`,
  );

  return passed;
}

// ---- Discovery steps ----

/**
 * Step 1: Try irHints from the company profile.
 * These are path fragments appended to the base website URL.
 */
async function tryHints(
  company: CompanyProfile,
): Promise<ScoredCandidate | null> {
  if (!company.irHints || company.irHints.length === 0) return null;

  for (const hint of company.irHints) {
    const url = resolveUrl(company.website, hint);
    if (!url) continue;

    log.info(`[${company.name}] Trying IR hint: ${url}`);
    const result = await fetchPage(url, 10_000);

    if (result.ok && result.response.status === 200) {
      const finalUrl = result.response.finalUrl;
      log.info(`[${company.name}] IR hint reachable: ${finalUrl}`);
      return { url: finalUrl, score: 100, source: 'hint' };
    }

    log.debug(
      `[${company.name}] IR hint failed: ${url} → ${!result.ok ? result.error.message : result.response.status}`,
    );
  }

  return null;
}

/**
 * Step 2: Fetch the homepage and scan all anchor elements.
 * Score each one and return sorted candidates above the minimum threshold.
 */
async function scanHomepage(
  company: CompanyProfile,
): Promise<ScoredCandidate[]> {
  log.info(`[${company.name}] Fetching homepage: ${company.website}`);
  const result = await fetchPage(company.website, 10_000);

  if (!result.ok) {
    log.warn(
      `[${company.name}] Homepage fetch failed: ${result.error.message}`,
    );
    return [];
  }

  const $ = cheerio.load(result.response.data);
  const baseUrl = result.response.finalUrl;
  const candidates: ScoredCandidate[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    const resolved = resolveUrl(baseUrl, href);
    if (!resolved) return;
    if (!isSameSite(baseUrl, resolved)) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);

    const text = $(el).text().trim().replace(/\s+/g, ' ');
    const score = scoreCandidate(text, resolved);

    if (score >= 3) {
      candidates.push({ url: resolved, score, source: `homepage-link:"${text}"` });
    }
  });

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0) {
    log.info(
      `[${company.name}] Found ${candidates.length} IR candidates from homepage`,
    );
    for (const c of candidates.slice(0, 5)) {
      log.info(`  ${c.score}pts — ${c.url} (${c.source})`);
    }
  } else {
    log.info(`[${company.name}] No IR candidates found on homepage`);
  }

  return candidates;
}

/**
 * Step 3: Brute-force common IR path patterns.
 * Only try paths not already covered by hints or homepage scan.
 */
async function bruteForceCommonPaths(
  company: CompanyProfile,
  alreadyTried: Set<string>,
): Promise<ScoredCandidate[]> {
  const candidates: ScoredCandidate[] = [];

  for (const pathFragment of COMMON_IR_PATHS) {
    const url = resolveUrl(company.website, pathFragment);
    if (!url || alreadyTried.has(url)) continue;
    alreadyTried.add(url);

    log.debug(`[${company.name}] Brute-force trying: ${url}`);
    const result = await fetchPage(url, 10_000);

    if (result.ok && result.response.status === 200) {
      const finalUrl = result.response.finalUrl;
      const score = scoreCandidate('investors', finalUrl);
      candidates.push({ url: finalUrl, score: Math.max(score, 5), source: 'brute-force' });
      log.info(`[${company.name}] Brute-force hit: ${finalUrl}`);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
 * Step 4: Check sitemap.xml for investor-related URLs.
 */
async function checkSitemap(
  company: CompanyProfile,
  alreadyTried: Set<string>,
): Promise<ScoredCandidate[]> {
  const sitemapUrl = resolveUrl(company.website, '/sitemap.xml');
  if (!sitemapUrl) return [];

  log.debug(`[${company.name}] Checking sitemap: ${sitemapUrl}`);
  const result = await fetchPage(sitemapUrl, 10_000);

  if (!result.ok) {
    log.debug(`[${company.name}] No sitemap found`);
    return [];
  }

  const $ = cheerio.load(result.response.data, { xmlMode: true });
  const candidates: ScoredCandidate[] = [];

  $('loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (!loc || alreadyTried.has(loc)) return;

    const path = getPath(loc);
    if (/investor|investerare/i.test(path)) {
      const score = scoreCandidate('investors', loc);
      candidates.push({ url: loc, score: Math.max(score, 5), source: 'sitemap' });
    }
  });

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0) {
    log.info(
      `[${company.name}] Found ${candidates.length} IR candidates from sitemap`,
    );
  }

  return candidates;
}

// ---- Main entry point ----

/**
 * Discover the IR page for a company using a multi-step fallback ladder.
 * Returns a StageResult<string> where value is the validated IR page URL.
 */
export async function discoverIrPage(
  company: CompanyProfile,
): Promise<StageResult<string>> {
  const startTime = Date.now();
  const alreadyTried = new Set<string>();

  log.info(`[${company.name}] Starting IR page discovery`);

  // Step 1: Try profile hints first (highest confidence)
  const hintResult = await tryHints(company);
  if (hintResult) {
    alreadyTried.add(hintResult.url);
    if (await validateIrPage(hintResult.url)) {
      log.info(
        `[${company.name}] ✓ IR page found via hint: ${hintResult.url}`,
      );
      return {
        status: 'success',
        value: hintResult.url,
        durationMs: Date.now() - startTime,
      };
    }
    log.warn(
      `[${company.name}] Hint URL reachable but failed validation — falling back`,
    );
  }

  // Step 2: Scan homepage links
  const homepageCandidates = await scanHomepage(company);
  for (const candidate of homepageCandidates) {
    if (alreadyTried.has(candidate.url)) continue;
    alreadyTried.add(candidate.url);

    if (await validateIrPage(candidate.url)) {
      log.info(
        `[${company.name}] ✓ IR page found via homepage scan: ${candidate.url} (score: ${candidate.score})`,
      );
      return {
        status: 'success',
        value: candidate.url,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Step 3: Brute-force common paths
  log.info(`[${company.name}] Homepage scan exhausted — trying common paths`);
  const bruteForceCandidates = await bruteForceCommonPaths(company, alreadyTried);
  for (const candidate of bruteForceCandidates) {
    if (alreadyTried.has(candidate.url)) continue;
    alreadyTried.add(candidate.url);

    if (await validateIrPage(candidate.url)) {
      log.info(
        `[${company.name}] ✓ IR page found via brute-force: ${candidate.url}`,
      );
      return {
        status: 'success',
        value: candidate.url,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Step 4: Sitemap fallback
  log.info(`[${company.name}] Common paths exhausted — checking sitemap`);
  const sitemapCandidates = await checkSitemap(company, alreadyTried);
  for (const candidate of sitemapCandidates) {
    if (alreadyTried.has(candidate.url)) continue;
    alreadyTried.add(candidate.url);

    if (await validateIrPage(candidate.url)) {
      log.info(
        `[${company.name}] ✓ IR page found via sitemap: ${candidate.url}`,
      );
      return {
        status: 'success',
        value: candidate.url,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // All steps exhausted
  log.error(
    `[${company.name}] ✗ Could not find IR page after all discovery steps`,
  );
  return {
    status: 'failed',
    value: null,
    error: `IR page not found after trying ${alreadyTried.size} candidate URLs`,
    durationMs: Date.now() - startTime,
  };
}
