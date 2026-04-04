// ---------------------------------------------------------------------------
// IR page discovery — heuristic-driven fallback ladder (generic).
//
// Strategy:
//   1. Scan homepage anchors and score them
//   2. Brute-force common IR paths
//   3. Check sitemap.xml for investor-related URLs
//
// No company-specific hints — works for any company given its website URL.
// ---------------------------------------------------------------------------

import * as cheerio from 'cheerio';
import { StageResult } from '../types';
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

const PATH_SCORES: { pattern: RegExp; points: number }[] = [
  { pattern: /\/investor/i, points: 5 },
  { pattern: /\/ir\//i, points: 4 },
  { pattern: /\/reports/i, points: 3 },
];

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

const LANG_BONUS: { pattern: RegExp; points: number }[] = [
  { pattern: /\/en\//i, points: 2 },
];

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
  '/company/investors',
  '/en/company/investors',
];

// ---- Scoring function ----

function scoreCandidate(text: string, href: string): number {
  let score = 0;

  for (const { pattern, points } of TEXT_SCORES) {
    if (pattern.test(text)) score += points;
  }

  for (const { pattern, points } of PATH_SCORES) {
    if (pattern.test(href)) score += points;
  }

  for (const { pattern, points } of PENALTY_KEYWORDS) {
    if (pattern.test(text)) score += points;
  }

  for (const { pattern, points } of LANG_BONUS) {
    if (pattern.test(href)) score += points;
  }

  return score;
}

// ---- Validation gate ----

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

async function scanHomepage(
  companyName: string,
  website: string,
): Promise<ScoredCandidate[]> {
  log.info(`[${companyName}] Fetching homepage: ${website}`);
  const result = await fetchPage(website, 10_000);

  if (!result.ok) {
    log.warn(`[${companyName}] Homepage fetch failed: ${result.error.message}`);
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
    log.info(`[${companyName}] Found ${candidates.length} IR candidates from homepage`);
    for (const c of candidates.slice(0, 5)) {
      log.info(`  ${c.score}pts — ${c.url} (${c.source})`);
    }
  } else {
    log.info(`[${companyName}] No IR candidates found on homepage`);
  }

  return candidates;
}

async function bruteForceCommonPaths(
  companyName: string,
  website: string,
  alreadyTried: Set<string>,
): Promise<ScoredCandidate[]> {
  const candidates: ScoredCandidate[] = [];

  for (const pathFragment of COMMON_IR_PATHS) {
    const url = resolveUrl(website, pathFragment);
    if (!url || alreadyTried.has(url)) continue;
    alreadyTried.add(url);

    log.debug(`[${companyName}] Brute-force trying: ${url}`);
    const result = await fetchPage(url, 10_000);

    if (result.ok && result.response.status === 200) {
      const finalUrl = result.response.finalUrl;
      const score = scoreCandidate('investors', finalUrl);
      candidates.push({ url: finalUrl, score: Math.max(score, 5), source: 'brute-force' });
      log.info(`[${companyName}] Brute-force hit: ${finalUrl}`);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

async function checkSitemap(
  companyName: string,
  website: string,
  alreadyTried: Set<string>,
): Promise<ScoredCandidate[]> {
  const sitemapUrl = resolveUrl(website, '/sitemap.xml');
  if (!sitemapUrl) return [];

  log.debug(`[${companyName}] Checking sitemap: ${sitemapUrl}`);
  const result = await fetchPage(sitemapUrl, 10_000);

  if (!result.ok) {
    log.debug(`[${companyName}] No sitemap found`);
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
    log.info(`[${companyName}] Found ${candidates.length} IR candidates from sitemap`);
  }

  return candidates;
}

// ---- Main entry point ----

/**
 * Discover the IR page for a company using a generic multi-step fallback ladder.
 * Requires a website URL (discovered upstream by search or provided by user).
 */
export async function discoverIrPage(
  companyName: string,
  website: string,
): Promise<StageResult<string>> {
  const startTime = Date.now();
  const alreadyTried = new Set<string>();

  log.info(`[${companyName}] Starting IR page discovery on ${website}`);

  // Step 1: Scan homepage links
  const homepageCandidates = await scanHomepage(companyName, website);
  for (const candidate of homepageCandidates) {
    if (alreadyTried.has(candidate.url)) continue;
    alreadyTried.add(candidate.url);

    if (await validateIrPage(candidate.url)) {
      log.info(`[${companyName}] IR page found via homepage scan: ${candidate.url} (score: ${candidate.score})`);
      return {
        status: 'success',
        value: candidate.url,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Step 2: Brute-force common paths
  log.info(`[${companyName}] Homepage scan exhausted — trying common paths`);
  const bruteForceCandidates = await bruteForceCommonPaths(companyName, website, alreadyTried);
  for (const candidate of bruteForceCandidates) {
    if (alreadyTried.has(candidate.url)) continue;
    alreadyTried.add(candidate.url);

    if (await validateIrPage(candidate.url)) {
      log.info(`[${companyName}] IR page found via brute-force: ${candidate.url}`);
      return {
        status: 'success',
        value: candidate.url,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Step 3: Sitemap fallback
  log.info(`[${companyName}] Common paths exhausted — checking sitemap`);
  const sitemapCandidates = await checkSitemap(companyName, website, alreadyTried);
  for (const candidate of sitemapCandidates) {
    if (alreadyTried.has(candidate.url)) continue;
    alreadyTried.add(candidate.url);

    if (await validateIrPage(candidate.url)) {
      log.info(`[${companyName}] IR page found via sitemap: ${candidate.url}`);
      return {
        status: 'success',
        value: candidate.url,
        durationMs: Date.now() - startTime,
      };
    }
  }

  log.error(`[${companyName}] Could not find IR page after all discovery steps`);
  return {
    status: 'failed',
    value: null,
    error: `IR page not found after trying ${alreadyTried.size} candidate URLs`,
    durationMs: Date.now() - startTime,
  };
}
